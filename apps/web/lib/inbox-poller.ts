import { db } from '@workspace/db'
import { connections, inboundEmails, appSettings, messages, leads } from '@workspace/db/schema'
import { decrypt } from '@workspace/core/crypto'
import { resolveImapConfig, fetchRecent } from '@workspace/core/email/imap'
import type { ParsedEmail } from '@workspace/core/email/imap'
import { eq, and, max, inArray } from 'drizzle-orm'

const TICK_MS = 120_000

let pollerHandle: ReturnType<typeof setInterval> | null = null

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

async function getWarmupKeywords(): Promise<string[]> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, 'warmup_keywords'))
  if (!row?.value?.trim()) return []
  return row.value
    .split(/[\n,]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
}

function isWarmupMatch(subject: string, bodyText: string | null, keywords: string[]): boolean {
  if (keywords.length === 0) return false
  const haystack = `${subject} ${bodyText ?? ''}`.toLowerCase()
  return keywords.some((kw) => haystack.includes(kw))
}

function normalizeMessageId(id: string): string | null {
  const normalized = id.replace(/^<|>$/g, '').trim()
  return normalized || null
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

async function classifyAndActOnInbound(email: ParsedEmail): Promise<void> {
  const isBounce = isBounceEmail(email)

  // Collect all referenced message IDs from inReplyTo and references headers
  const refs = new Set<string>()
  if (email.inReplyTo) {
    const n = normalizeMessageId(email.inReplyTo)
    if (n) refs.add(n)
  }
  if (email.references) {
    for (const r of email.references.split(/\s+/)) {
      const n = normalizeMessageId(r)
      if (n) refs.add(n)
    }
  }

  if (refs.size === 0) return

  // Find sent messages matching any referenced ID
  const refArray = [...refs]
  const matched = await db
    .select({ leadId: messages.leadId })
    .from(messages)
    .where(inArray(messages.messageId, refArray))
    .limit(1)

  if (matched.length === 0) return

  const leadId = matched[0]!.leadId

  // Don't downgrade an already-bounced lead to replied
  const [currentLead] = await db
    .select({ status: leads.status })
    .from(leads)
    .where(eq(leads.id, leadId))

  if (!currentLead || currentLead.status === 'bounced') return

  const newStatus = isBounce ? 'bounced' : 'replied'

  await db.update(leads).set({ status: newStatus }).where(eq(leads.id, leadId))

  // Stop all future queued messages for this lead
  await db
    .update(messages)
    .set({ status: 'skipped' })
    .where(and(eq(messages.leadId, leadId), eq(messages.status, 'queued')))

  console.log(
    `[Lightreach] Inbox: lead ${leadId} marked as ${newStatus} (${isBounce ? 'bounce' : 'reply'} detected)`,
  )
}

export async function pollAllInboxes(): Promise<void> {
  const allConnections = await db
    .select()
    .from(connections)
    .where(eq(connections.imapEnabled, true))

  if (allConnections.length === 0) return

  const keywords = await getWarmupKeywords()

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

      const emails = await fetchRecent(imapConfig, { sinceUid, limit: 100 })

      for (const email of emails) {
        const warmup = isWarmupMatch(email.subject, email.bodyText, keywords)

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
            isWarmup: warmup,
            receivedAt: email.receivedAt,
          })
          .onConflictDoNothing()

        // Only classify newly inserted emails (skip duplicates)
        if (inserted.changes > 0) {
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
