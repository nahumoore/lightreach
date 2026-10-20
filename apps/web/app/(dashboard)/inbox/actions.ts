'use server'
import { db, inboundEmails, appSettings, connections, messages, leads, lists } from '@workspace/db'
import { eq, and, or, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { decrypt } from '@workspace/core/crypto'
import { sendMail, buildMessageId } from '@workspace/core/email/transport'
import {
  pollAllInboxes,
  normalizeMessageId,
  matchLeadByReferences,
  matchLeadByEmail,
  matchLeadBySubject,
} from '@/lib/inbox-poller'
import { randomUUID } from 'crypto'

export async function markRead(id: number) {
  await db.update(inboundEmails).set({ isRead: true }).where(eq(inboundEmails.id, id))
  revalidatePath('/inbox')
}

export async function markUnread(id: number) {
  await db.update(inboundEmails).set({ isRead: false }).where(eq(inboundEmails.id, id))
  revalidatePath('/inbox')
}

/**
 * Marks every inbound email in the conversation as read and returns their ids,
 * so the caller can update its own copy. Returns [] if the email doesn't exist.
 */
export async function markThreadRead(inboundId: number): Promise<number[]> {
  const inbound = await getThreadAnchor(inboundId)
  if (!inbound) return []

  const updated = await db
    .update(inboundEmails)
    .set({ isRead: true })
    .where(threadInboundFilter(inbound))
    .returning({ id: inboundEmails.id })
  revalidatePath('/inbox')
  return updated.map((r) => r.id)
}

export async function saveFilteredKeywords(keywords: string) {
  await db
    .insert(appSettings)
    .values({ key: 'filter_keywords', value: keywords })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: keywords, updatedAt: new Date() },
    })

  // Re-flag existing rows based on the new keyword list
  const kws = keywords
    .split(/[\n,]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)

  if (kws.length > 0) {
    const allEmails = await db
      .select({ id: inboundEmails.id, subject: inboundEmails.subject, bodyText: inboundEmails.bodyText })
      .from(inboundEmails)

    for (const row of allEmails) {
      const haystack = `${row.subject} ${row.bodyText ?? ''}`.toLowerCase()
      const isFiltered = kws.some((kw) => haystack.includes(kw))
      await db.update(inboundEmails).set({ isFiltered }).where(eq(inboundEmails.id, row.id))
    }
  } else {
    // No keywords → clear all filtered flags
    await db.update(inboundEmails).set({ isFiltered: false })
  }

  revalidatePath('/inbox')
}

// ---------------------------------------------------------------------------
// Thread resolution helper
// ---------------------------------------------------------------------------

/**
 * Given an inbound email, attempt to locate the originating outbound campaign
 * message. Tries, in order of reliability:
 *   1. RFC822 threading headers (In-Reply-To / References → messages.messageId)
 *   2. a case-insensitive sender-address lookup against leads we've emailed
 *   3. the reply's subject, scoped to the mailbox it arrived on
 *
 * (3) exists for delegated / forwarded / aliased replies: they arrive from an
 * address that differs from the lead we emailed and often drop the threading
 * headers, so (1) and (2) both miss. Pass `subject`/`connectionId` to enable it.
 *
 * Returns { leadId, campaignId } if resolved, otherwise null.
 */
async function resolveThreadLead(
  inbound: {
    inReplyTo: string | null
    references: string | null
    fromEmail: string
    subject?: string | null
    connectionId?: number | null
  },
): Promise<{ leadId: number; campaignId: number | null } | null> {
  const byReferences = await matchLeadByReferences(inbound.inReplyTo, inbound.references)
  if (byReferences) return byReferences

  const byEmail = await matchLeadByEmail(inbound.fromEmail)
  if (byEmail) return byEmail

  if (inbound.subject !== undefined) {
    return matchLeadBySubject(inbound.subject, inbound.connectionId ?? null)
  }
  return null
}

// ---------------------------------------------------------------------------
// Find or create a lead from an inbound sender (used when replying to someone
// who is not yet in the leads table, e.g. an email from an external contact).
// ---------------------------------------------------------------------------

async function findOrCreateLeadFromInbound(
  inbound: { fromEmail: string; fromName: string },
): Promise<number> {
  const email = inbound.fromEmail.toLowerCase().trim()

  // Return existing lead if one already exists for this address
  const [existing] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(sql`lower(${leads.email})`, email))
  if (existing) return existing.id

  // Find-or-create the "Inbox Replies" list that holds auto-created leads
  let [list] = await db
    .select({ id: lists.id })
    .from(lists)
    .where(eq(lists.name, 'Inbox Replies'))
  if (!list) {
    ;[list] = await db
      .insert(lists)
      .values({ name: 'Inbox Replies' })
      .returning({ id: lists.id })
  }

  const [firstName, ...rest] = (inbound.fromName || '').trim().split(/\s+/)
  const [lead] = await db
    .insert(leads)
    .values({
      listId: list!.id,
      email,
      firstName: firstName ?? '',
      lastName: rest.join(' '),
      status: 'replied', // already in active conversation
    })
    .returning({ id: leads.id })

  return lead!.id
}

// ---------------------------------------------------------------------------
// Reply to inbound email
// ---------------------------------------------------------------------------

export async function replyToEmail(
  inboundId: number,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  const [inbound] = await db
    .select()
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundId))

  if (!inbound) return { ok: false, error: 'Message not found' }
  if (!inbound.connectionId) return { ok: false, error: 'No mailbox associated with this message' }

  const [conn] = await db.select().from(connections).where(eq(connections.id, inbound.connectionId))
  if (!conn) return { ok: false, error: 'Mailbox not found' }

  let smtpPass: string
  try {
    smtpPass = decrypt(conn.smtpPassEncrypted)
  } catch {
    return { ok: false, error: 'Failed to decrypt mailbox credentials' }
  }

  const subject = /^\s*re:/i.test(inbound.subject)
    ? inbound.subject
    : `Re: ${inbound.subject}`

  const refsHeader = [inbound.references, inbound.messageId]
    .filter(Boolean)
    .join(' ')
    .trim() || undefined

  // Pre-generate so the messageId is always known and can be stored
  const outboundMessageId = buildMessageId(conn.fromEmail, randomUUID())

  try {
    await sendMail(
      {
        smtpHost: conn.smtpHost,
        smtpPort: conn.smtpPort,
        smtpSecure: conn.smtpSecure,
        smtpUser: conn.smtpUser,
        smtpPass,
      },
      {
        fromName: conn.fromName,
        fromEmail: conn.fromEmail,
        to: inbound.fromEmail,
        subject,
        html: body.replace(/\n/g, '<br>'),
        text: body,
        messageId: outboundMessageId,
        inReplyTo: inbound.messageId ?? undefined,
        references: refsHeader,
      },
    )

    // Persist the reply as a messages row so it shows in the thread view.
    // Prefer the lead the poller linked to this email; otherwise resolve it now.
    // If the sender is not yet a lead, auto-create them in the "Inbox Replies"
    // list so the reply is always stored and visible in the conversation thread.
    const thread = inbound.leadId != null
      ? { leadId: inbound.leadId, campaignId: inbound.campaignId }
      : await resolveThreadLead({
          inReplyTo: inbound.inReplyTo,
          references: inbound.references,
          fromEmail: inbound.fromEmail,
          subject: inbound.subject,
          connectionId: inbound.connectionId,
        })
    const leadId = thread?.leadId ?? await findOrCreateLeadFromInbound({
      fromEmail: inbound.fromEmail,
      fromName: inbound.fromName,
    })
    await db.insert(messages).values({
      campaignId: thread?.campaignId ?? null,
      leadId,
      connectionId: inbound.connectionId,
      stepPosition: 0, // 0 = manual reply, not a sequence step
      status: 'sent',
      sentAt: new Date(),
      messageId: normalizeMessageId(outboundMessageId),
      renderedSubject: subject,
      renderedBody: body.replace(/\n/g, '<br>'),
    })

    await db.update(inboundEmails).set({ isRead: true, repliedAt: new Date() }).where(eq(inboundEmails.id, inboundId))
    revalidatePath('/inbox')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function categorizeEmail(id: number, category: string) {
  await db.update(inboundEmails).set({ category }).where(eq(inboundEmails.id, id))
  revalidatePath('/inbox')
}

/** Sets the label on every inbound email linked to the lead. Returns how many rows changed. */
export async function setLeadLabel(leadId: number, category: string): Promise<number> {
  const result = await db.update(inboundEmails).set({ category }).where(eq(inboundEmails.leadId, leadId))
  revalidatePath('/inbox')
  return result.changes
}

export async function triggerFetch(): Promise<{ ok: boolean; error?: string }> {
  try {
    await pollAllInboxes()
    revalidatePath('/inbox')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type ThreadMessage = {
  id: number
  direction: 'inbound' | 'outbound'
  subject: string | null
  /** Plain text for inbound mail, rendered HTML for outbound */
  body: string | null
  /** Inbound only */
  bodyHtml: string | null
  date: string | null
  fromName: string | null
  fromEmail: string | null
  /** Label of the mailbox that received (inbound) or sent (outbound) the message */
  mailbox: string | null
  /** Inbound only */
  isRead: boolean | null
}

/** The fields of an inbound email needed to find the rest of its conversation. */
async function getThreadAnchor(inboundId: number) {
  const [inbound] = await db
    .select({
      id: inboundEmails.id,
      leadId: inboundEmails.leadId,
      inReplyTo: inboundEmails.inReplyTo,
      references: inboundEmails.references,
      fromEmail: inboundEmails.fromEmail,
      subject: inboundEmails.subject,
      connectionId: inboundEmails.connectionId,
    })
    .from(inboundEmails)
    .where(eq(inboundEmails.id, inboundId))
  return inbound
}

/**
 * The inbound emails that make up one conversation. When the poller linked the
 * email to a lead, that is every email linked to the same lead (so replies from
 * a colleague on the same domain are included). Otherwise it falls back to
 * every email from the same sender address. The email itself is always
 * included, even if it is a bounce.
 */
function threadInboundFilter(inbound: { id: number; leadId: number | null; fromEmail: string }) {
  const sameConversation =
    inbound.leadId != null
      ? eq(inboundEmails.leadId, inbound.leadId)
      : eq(sql`lower(${inboundEmails.fromEmail})`, inbound.fromEmail.toLowerCase())

  return or(
    eq(inboundEmails.id, inbound.id),
    and(sameConversation, eq(inboundEmails.isDuplicate, false), eq(inboundEmails.isBounce, false)),
  )
}

/**
 * Full two-way conversation for an inbound email: the lead's outbound sends
 * merged with all of their inbound replies, in chronological order. Used by
 * the /inbox thread panel and the MCP get_thread tool.
 *
 * The lead comes from the email's own link when it has one, otherwise from
 * threading headers, sender address, then (display only) the subject.
 */
export async function getFullThread(inboundId: number): Promise<ThreadMessage[]> {
  const inbound = await getThreadAnchor(inboundId)
  if (!inbound) return []

  const leadId = inbound.leadId ?? (await resolveThreadLead(inbound))?.leadId

  const [outboundRows, inboundRows] = await Promise.all([
    leadId != null
      ? db
          .select({
            id: messages.id,
            subject: messages.renderedSubject,
            body: messages.renderedBody,
            sentAt: messages.sentAt,
            fromEmail: connections.fromEmail,
            mailbox: connections.label,
          })
          .from(messages)
          .leftJoin(connections, eq(messages.connectionId, connections.id))
          .where(and(eq(messages.status, 'sent'), eq(messages.leadId, leadId)))
          .orderBy(messages.sentAt)
      : Promise.resolve([]),
    db
      .select({
        id: inboundEmails.id,
        subject: inboundEmails.subject,
        body: inboundEmails.bodyText,
        bodyHtml: inboundEmails.bodyHtml,
        receivedAt: inboundEmails.receivedAt,
        fromName: inboundEmails.fromName,
        fromEmail: inboundEmails.fromEmail,
        mailbox: connections.label,
        isRead: inboundEmails.isRead,
      })
      .from(inboundEmails)
      .leftJoin(connections, eq(inboundEmails.connectionId, connections.id))
      .where(threadInboundFilter(inbound))
      .orderBy(inboundEmails.receivedAt),
  ])

  const toIso = (d: Date | number | null): string | null => {
    if (!d) return null
    return d instanceof Date ? d.toISOString() : new Date((d as number) * 1000).toISOString()
  }

  const combined: ThreadMessage[] = [
    ...outboundRows.map((r) => ({
      id: r.id,
      direction: 'outbound' as const,
      subject: r.subject ?? null,
      body: r.body ?? null,
      bodyHtml: null,
      date: toIso(r.sentAt),
      fromName: null,
      fromEmail: r.fromEmail ?? null,
      mailbox: r.mailbox ?? null,
      isRead: null,
    })),
    ...inboundRows.map((r) => ({
      id: r.id,
      direction: 'inbound' as const,
      subject: r.subject ?? null,
      body: r.body ?? null,
      bodyHtml: r.bodyHtml ?? null,
      date: toIso(r.receivedAt),
      fromName: r.fromName || null,
      fromEmail: r.fromEmail ?? null,
      mailbox: r.mailbox ?? null,
      isRead: r.isRead,
    })),
  ]

  combined.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  return combined
}
