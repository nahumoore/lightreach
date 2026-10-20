import { db } from '@workspace/db'
import { connections, inboundEmails, appSettings, messages, leads } from '@workspace/db/schema'
import { decrypt } from '@workspace/core/crypto'
import { resolveImapConfig, fetchRecent } from '@workspace/core/email/imap'
import type { ParsedEmail } from '@workspace/core/email/imap'
import { eq, and, max, inArray, sql, isNotNull, desc } from 'drizzle-orm'
import { isWarmupMessage } from '@/lib/warmup'

const TICK_MS = 120_000

let pollerHandle: ReturnType<typeof setInterval> | null = null
let isPolling = false

export function startInboxPoller(): void {
  if (pollerHandle) {
    console.log('[Lightreach] Inbox poller already running.')
    return
  }

  console.log('[Lightreach] Inbox poller started. Tick interval:', TICK_MS, 'ms')

  pollerHandle = setInterval(() => {
    pollAllInboxes().catch((err) => {
      console.error('[Lightreach] Inbox poller tick error:', err)
    })
  }, TICK_MS)

  pollAllInboxes().catch((err) => {
    console.error('[Lightreach] Inbox poller startup error:', err)
  })

  pollerHandle.unref()
}

export function stopInboxPoller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle)
    pollerHandle = null
    console.log('[Lightreach] Inbox poller stopped.')
  }
}

async function getFilteredKeywords(): Promise<string[]> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, 'filter_keywords'))
  if (!row?.value?.trim()) return []
  return row.value
    .split(/[\n,]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
}

function isFilteredMatch(subject: string, bodyText: string | null, keywords: string[]): boolean {
  if (keywords.length === 0) return false
  const haystack = `${subject} ${bodyText ?? ''}`.toLowerCase()
  return keywords.some((kw) => haystack.includes(kw))
}

export function normalizeMessageId(id: string): string | null {
  const normalized = id.replace(/^<|>$/g, '').trim()
  return normalized || null
}

/**
 * Decides whether an about-to-be-inserted inbound email is a duplicate of one
 * already in the DB, regardless of which connection it came in on.
 *
 * A delegated/shared mailbox polled through two separate connections (e.g. an
 * owner account and a delegate account both configured in Lightreach) sees the
 * same physical message twice, each with its own per-connection UID — the
 * `(connectionId, uid)` unique index doesn't catch that.
 *
 * Which copy is "canonical" matters beyond just hiding the extra row: replying
 * uses the canonical row's mailbox. So canonical isn't "whichever landed
 * first" — it's whichever connection's own address is the message's actual
 * recipient (`toEmail`). If an earlier poll happened to insert the mirrored
 * copy first, this demotes it and promotes the true-recipient copy instead.
 */
async function resolveDuplicateOnInsert(
  messageId: string,
  toEmail: string,
  connectionFromEmail: string,
): Promise<{ isDuplicate: boolean }> {
  const normalized = normalizeMessageId(messageId)
  if (!normalized) return { isDuplicate: false }

  const existingRows = await db
    .select({
      id: inboundEmails.id,
      isDuplicate: inboundEmails.isDuplicate,
      connectionFromEmail: connections.fromEmail,
    })
    .from(inboundEmails)
    .leftJoin(connections, eq(inboundEmails.connectionId, connections.id))
    .where(sql`replace(replace(${inboundEmails.messageId}, '<', ''), '>', '') = ${normalized}`)

  if (existingRows.length === 0) return { isDuplicate: false }

  const newIsTrueRecipient = connectionFromEmail.toLowerCase() === toEmail.toLowerCase()
  const canonical = existingRows.find((r) => !r.isDuplicate)
  const canonicalIsTrueRecipient = canonical?.connectionFromEmail?.toLowerCase() === toEmail.toLowerCase()

  if (canonical && newIsTrueRecipient && !canonicalIsTrueRecipient) {
    await db.update(inboundEmails).set({ isDuplicate: true }).where(eq(inboundEmails.id, canonical.id))
    return { isDuplicate: false }
  }

  return { isDuplicate: true }
}

function isBounceEmail(email: ParsedEmail): boolean {
  const from = email.fromEmail.toLowerCase()
  const name = email.fromName.toLowerCase()
  const subject = email.subject.toLowerCase()

  if (/^(mailer-daemon|postmaster|mail-daemon)@/i.test(from)) return true
  if (/\b(mailer.daemon|mail delivery subsystem|delivery status notification|postmaster)\b/i.test(name)) return true
  if (/\b(undeliverable|delivery (status notification|failure)|mail delivery failed|returned mail|non.delivery report|failure notice|could not be delivered)\b/i.test(subject)) return true

  return false
}

const OUT_OF_OFFICE_SUBJECT_RE =
  /\b(out.of.office|automatic reply|auto.?reply|vacation (response|reply)|away from (the )?office)\b/i

// Outbound mail asks recipients to reply "STOP" instead of clicking a link.
// Matched against the first non-empty line only, so it triggers on a genuine
// one-word/one-phrase opt-out reply but not on "stop" appearing mid-sentence
// in an unrelated reply (or in the quoted history below a top-posted reply).
const UNSUBSCRIBE_REPLY_RE = /^(please\s+)?(stop|unsubscribe(\s+me)?|remove\s+me|opt[\s-]?out)[.!]?$/i

function isUnsubscribeReply(bodyText: string | null, subject: string): boolean {
  const firstLine = (bodyText ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (firstLine && UNSUBSCRIBE_REPLY_RE.test(firstLine)) return true

  const cleanSubject = subject.replace(/^re:\s*/i, '').trim()
  return UNSUBSCRIBE_REPLY_RE.test(cleanSubject)
}

export type LeadMatch = { leadId: number; campaignId: number | null }

/** Domain part of an email address, lowercased. Used to tolerate replies that
 *  arrive from a different mailbox on the same domain (e.g. a shared team
 *  inbox where the reply comes from support@ instead of the hello@ address
 *  we originally emailed). */
function emailDomain(addr: string): string {
  return addr.toLowerCase().trim().split('@')[1] ?? ''
}

/** Strip any run of leading "Re:" prefixes and normalize for comparison. */
export function normalizeSubject(subject: string | null): string {
  return (subject ?? '')
    .replace(/^\s*(re:\s*)+/i, '')
    .trim()
    .toLowerCase()
}

/**
 * Last-resort match by subject, scoped to the mailbox that received the reply.
 *
 * Delegated / forwarded / aliased replies routinely arrive from an address
 * that differs from the lead we emailed *and* drop the In-Reply-To/References
 * headers, so neither {@link matchLeadByReferences} nor {@link matchLeadByEmail}
 * can connect them. The one signal that survives is the (normalized) subject.
 *
 * Scoped to `connectionId` so a subject reused across mailboxes can't cross-link
 * unrelated conversations; picks the most recently sent match. This is a display
 * heuristic only — when the same subject was sent to several leads on one mailbox
 * it may attribute to the wrong lead, so callers must not use it to drive
 * state changes (e.g. marking a lead 'replied').
 */
export async function matchLeadBySubject(
  subject: string | null,
  connectionId: number | null,
): Promise<LeadMatch | null> {
  const normalized = normalizeSubject(subject)
  if (!normalized) return null

  const conds = [eq(messages.status, 'sent'), isNotNull(messages.renderedSubject)]
  if (connectionId != null) conds.push(eq(messages.connectionId, connectionId))

  const candidates = await db
    .select({
      leadId: messages.leadId,
      campaignId: messages.campaignId,
      renderedSubject: messages.renderedSubject,
    })
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.sentAt))
    .limit(500)

  const hit = candidates.find((c) => normalizeSubject(c.renderedSubject) === normalized)
  if (!hit) return null
  return { leadId: hit.leadId, campaignId: hit.campaignId }
}

/**
 * Resolve a lead by walking RFC822 threading headers (In-Reply-To / References
 * → messages.messageId). This is the most reliable signal — shared with the
 * manual reply-thread UI so the two paths never disagree.
 */
export async function matchLeadByReferences(
  inReplyTo: string | null,
  references: string | null,
): Promise<LeadMatch | null> {
  const refs = new Set<string>()
  if (inReplyTo) {
    const n = normalizeMessageId(inReplyTo)
    if (n) refs.add(n)
  }
  if (references) {
    for (const r of references.split(/\s+/)) {
      const n = normalizeMessageId(r)
      if (n) refs.add(n)
    }
  }

  if (refs.size === 0) return null

  const matched = await db
    .select({ leadId: messages.leadId, campaignId: messages.campaignId })
    .from(messages)
    .where(inArray(messages.messageId, [...refs]))
    .limit(1)

  if (matched.length === 0) return null
  return { leadId: matched[0]!.leadId, campaignId: matched[0]!.campaignId }
}

/**
 * Fallback match by sender address against leads we've actually emailed —
 * catches replies/bounces that stripped or never carried threading headers.
 * Only matches leads with at least one 'sent' message, so it can't associate
 * an unrelated inbound sender with a lead we've never contacted.
 */
export async function matchLeadByEmail(fromEmail: string): Promise<LeadMatch | null> {
  const lowerEmail = fromEmail.toLowerCase().trim()
  if (!lowerEmail) return null

  const matchingLeads = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(sql`lower(${leads.email})`, lowerEmail))

  if (matchingLeads.length === 0) return null
  const leadIds = matchingLeads.map((l) => l.id)

  const sentMsg = await db
    .select({ leadId: messages.leadId, campaignId: messages.campaignId })
    .from(messages)
    .where(and(eq(messages.status, 'sent'), inArray(messages.leadId, leadIds)))
    .limit(1)

  if (sentMsg.length === 0) return null
  return { leadId: sentMsg[0]!.leadId, campaignId: sentMsg[0]!.campaignId }
}

async function markLeadStatus(
  leadId: number,
  status: 'replied' | 'bounced' | 'unsubscribed',
  context: string,
): Promise<void> {
  const [currentLead] = await db.select({ status: leads.status }).from(leads).where(eq(leads.id, leadId))
  // Terminal statuses (bounced/unsubscribed) never get overwritten by a later reply.
  if (!currentLead || currentLead.status === 'bounced' || currentLead.status === 'unsubscribed') return

  await db.update(leads).set({ status }).where(eq(leads.id, leadId))
  await db
    .update(messages)
    .set({ status: 'skipped' })
    .where(and(eq(messages.leadId, leadId), eq(messages.status, 'queued')))

  console.log(`[Lightreach] Inbox: lead ${leadId} marked as ${status} (${context})`)
}

/**
 * DSN/bounce messages almost never carry In-Reply-To/References to the
 * original outbound mail — they embed the original headers inline instead.
 * Try, in order: threading headers (rare but possible), an embedded
 * Message-ID recovered from the raw DSN body, then the DSN's declared
 * failed-recipient address matched against a lead we've actually emailed.
 */
async function handleBounce(email: ParsedEmail): Promise<void> {
  let match = await matchLeadByReferences(email.inReplyTo, email.references)

  if (!match && email.embeddedMessageIds.length > 0) {
    const found = await db
      .select({ leadId: messages.leadId, campaignId: messages.campaignId })
      .from(messages)
      .where(inArray(messages.messageId, email.embeddedMessageIds))
      .limit(1)
    if (found.length > 0) match = { leadId: found[0]!.leadId, campaignId: found[0]!.campaignId }
  }

  if (!match) {
    for (const addr of email.failedRecipients) {
      match = await matchLeadByEmail(addr)
      if (match) break
    }
  }

  if (!match) {
    console.log('[Lightreach] Inbox: bounce notification received but could not be matched to a lead')
    return
  }

  await markLeadStatus(match.leadId, 'bounced', 'DSN bounce')
}

async function classifyAndActOnInbound(email: ParsedEmail): Promise<void> {
  if (isBounceEmail(email)) {
    await handleBounce(email)
    return
  }

  // Auto-responders are informational only — don't halt the sequence over them.
  if (OUT_OF_OFFICE_SUBJECT_RE.test(email.subject)) return

  // Header-threading match, cross-checked against the matched lead's own
  // domain so a forwarded copy of our email replied to by an unrelated third
  // party (or an auto-responder on an unrelated domain) doesn't count as a
  // reply. Domain-level (not exact-address) comparison because replies
  // routinely arrive from a different mailbox on the same domain — e.g. a
  // shared team inbox where the reply comes from support@ instead of the
  // hello@ address we originally emailed.
  let match = await matchLeadByReferences(email.inReplyTo, email.references)
  if (match) {
    const [matchedLead] = await db.select({ email: leads.email }).from(leads).where(eq(leads.id, match.leadId))
    if (!matchedLead || emailDomain(matchedLead.email) !== emailDomain(email.fromEmail)) {
      match = null
    }
  }

  // Fall back to a sender-email match for replies that stripped threading headers.
  if (!match) {
    match = await matchLeadByEmail(email.fromEmail)
  }

  if (!match) return

  if (isUnsubscribeReply(email.bodyText, email.subject)) {
    await markLeadStatus(match.leadId, 'unsubscribed', 'unsubscribe keyword in reply')
    return
  }

  await markLeadStatus(match.leadId, 'replied', 'reply detected')
}

export async function pollAllInboxes(): Promise<void> {
  // The previous run's IMAP round-trips can outlast this tick's 120s interval;
  // without this guard, an overlapping run would refetch the same UID range
  // and race the first run's writes.
  if (isPolling) return
  isPolling = true
  try {
    await runPoll()
  } finally {
    isPolling = false
  }
}

async function runPoll(): Promise<void> {
  const allConnections = await db
    .select()
    .from(connections)
    .where(eq(connections.imapEnabled, true))

  if (allConnections.length === 0) return

  const keywords = await getFilteredKeywords()

  for (const conn of allConnections) {
    try {
      const imapConfig = resolveImapConfig(conn, decrypt)
      if (!imapConfig) continue

      // Find the highest UID we already have for this connection
      const [uidRow] = await db
        .select({ maxUid: max(inboundEmails.uid) })
        .from(inboundEmails)
        .where(eq(inboundEmails.connectionId, conn.id))

      const sinceUid = uidRow?.maxUid ?? 0

      const { emails, uidValidity } = await fetchRecent(imapConfig, {
        sinceUid,
        limit: 100,
        expectedUidValidity: conn.imapUidValidity,
      })

      if (uidValidity != null && uidValidity !== conn.imapUidValidity) {
        if (conn.imapUidValidity != null) {
          console.warn(
            `[Lightreach] Inbox: UIDVALIDITY changed for connection ${conn.id} — resynced from scratch`,
          )
        }
        await db
          .update(connections)
          .set({ imapUidValidity: uidValidity })
          .where(eq(connections.id, conn.id))
      }

      for (const email of emails) {
        const filtered = isFilteredMatch(email.subject, email.bodyText, keywords)
        const bounce = isBounceEmail(email)
        // Resolved before insert: may flip an existing row from canonical to
        // duplicate if this connection turns out to be the true recipient —
        // still inserted either way to advance this connection's UID cursor.
        const dupResolution = email.messageId
          ? await resolveDuplicateOnInsert(email.messageId, email.toEmail, conn.fromEmail)
          : { isDuplicate: false }
        // Mailbox-to-mailbox warmup traffic is still inserted (it advances the UID
        // cursor) but hidden from the inbox and never classified as a lead reply.
        const warmup = await isWarmupMessage(email)

        const inserted = await db
          .insert(inboundEmails)
          .values({
            connectionId: conn.id,
            uid: email.uid,
            messageId: email.messageId,
            inReplyTo: email.inReplyTo,
            references: email.references,
            fromName: email.fromName,
            fromEmail: email.fromEmail,
            toEmail: email.toEmail,
            subject: email.subject,
            bodyText: email.bodyText,
            bodyHtml: email.bodyHtml,
            isFiltered: filtered,
            isBounce: bounce,
            isDuplicate: dupResolution.isDuplicate,
            isWarmup: warmup,
            receivedAt: email.receivedAt,
          })
          .onConflictDoNothing()

        // Only classify newly inserted, non-duplicate emails — a duplicate was
        // already classified (bounce/reply/unsubscribe) when its first copy landed.
        if (inserted.changes > 0 && !dupResolution.isDuplicate && !warmup) {
          await classifyAndActOnInbound(email)
        }
      }

      if (emails.length > 0) {
        console.log(
          `[Lightreach] Inbox: fetched ${emails.length} new message(s) for connection ${conn.id} (${conn.fromEmail})`,
        )
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(
        `[Lightreach] Inbox poller error for connection ${conn.id} (${conn.fromEmail}):`,
        errMsg,
      )
      await db
        .update(connections)
        .set({ lastError: `IMAP: ${errMsg}` })
        .where(eq(connections.id, conn.id))
    }
  }
}
