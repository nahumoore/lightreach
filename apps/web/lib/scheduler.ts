import { db } from '@workspace/db'
import {
  messages,
  campaigns,
  campaignConnections,
  connections,
  leads,
  sequenceSteps,
} from '@workspace/db/schema'
import { decrypt } from '@workspace/core/crypto'
import { sendMail, buildMessageId, appendUnsubscribeFooter } from '@workspace/core/email/transport'
import { pickNext, isWithinSendWindow, randomDelayMs, startOfDayInTimezone } from '@workspace/core/rotation'
import { expandSpintax } from '@workspace/core/spintax'
import { renderVariables } from '@workspace/core/variables'
import { classifyBounce } from '@workspace/core/email/bounce'
import { eq, and, lt, lte, gte, isNotNull, asc, desc, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { enqueueNewLeads } from '@/lib/enqueue-leads'
import { isSuppressed, suppress, buildUnsubscribeHeaders } from '@/lib/suppression'

const TICK_MS = 60_000
const BATCH_SIZE = 10
/** Terminal after this many attempts — earlier attempts re-queue with backoff. */
const MAX_ATTEMPTS = 3
/** A mailbox is only auto-disabled after this many consecutive (non-bounce) failures. */
const CONNECTION_ERROR_THRESHOLD = 3
const RETRY_BACKOFF_BASE_MS = 5 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null
  return id.replace(/^<|>$/g, '').trim() || null
}

/** RCPT TO rejections that are about our mailbox, not the recipient. */
const SENDER_SIDE_RE = /sender address rejected|relay access denied|relaying denied|sending limit|rate limit/i

/**
 * What a failed send says about the lead. Only a rejection of the recipient
 * itself (nodemailer sets `command` to 'RCPT TO') is about the lead. Errors at
 * MAIL FROM, DATA, AUTH or the connection are the mailbox's problem, so they
 * never change the lead and go through the retry path.
 *
 *   'hard'  the address is dead: lead bounced and the address suppressed
 *   'block' permanent rejection, not proof the address is dead (policy, spam):
 *           lead bounced, address not suppressed
 *   null    anything else: retry with backoff
 *
 * Only 550-554 are treated as recipient rejections, as before. Some servers
 * reject the sender at RCPT TO too (bad sender domain, relay denied, sending
 * limit); those are the mailbox's problem and also go through the retry path.
 */
function classifySendFailure(err: unknown): 'hard' | 'block' | null {
  const e = err as { command?: string; responseCode?: number; response?: string }
  const code = e.responseCode
  if (e.command !== 'RCPT TO' || code === undefined || code < 550 || code > 554) return null

  const text = e.response ?? (err instanceof Error ? err.message : String(err))
  const status = /\b[245]\.\d{1,3}\.\d{1,3}\b/.exec(text)?.[0]
  if ((status && /^5\.(1\.[78]|4\.5)$/.test(status)) || SENDER_SIDE_RE.test(text)) return null

  const kind = classifyBounce({
    smtpCode: code,
    status,
    diagnostic: text,
  })
  // Soft here is a full mailbox (552 / 5.2.2): retry like any transient error.
  return kind === 'soft' ? null : kind
}

let schedulerHandle: ReturnType<typeof setInterval> | null = null
let ticking = false
let recovered = false
/** Round-robin cursor per campaign, persisted across ticks so low-id mailboxes
 *  aren't systematically favored every time the tick loop restarts. */
const lastUsedConnectionByCampaign = new Map<number, number>()

export function startScheduler(): void {
  if (schedulerHandle) {
    console.log('[Lightreach] Scheduler already running.')
    return
  }

  console.log('[Lightreach] Scheduler started. Tick interval:', TICK_MS, 'ms')

  schedulerHandle = setInterval(() => {
    tick().catch((err) => {
      console.error('[Lightreach] Scheduler tick error:', err)
    })
  }, TICK_MS)

  // Run immediately on startup to catch overdue messages
  tick().catch((err) => {
    console.error('[Lightreach] Scheduler startup tick error:', err)
  })

  schedulerHandle.unref()
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle)
    schedulerHandle = null
    console.log('[Lightreach] Scheduler stopped.')
  }
}

type ConnRow = {
  id: number
  status: string
  dailyLimit: number
  consecutiveFailures: number
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPassEncrypted: string
  fromName: string
  fromEmail: string
}

/** Serial wrapper: setInterval has no built-in reentrancy guard, and a batch of
 *  slow SMTP sends (plus jitter delays) can easily outlast one 60s interval. */
async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    if (!recovered) {
      // Rows left in 'sending' from a process crash mid-send must go back to
      // 'queued' or they'd be stuck forever (never re-selected, never resent).
      await db
        .update(messages)
        .set({ status: 'queued' })
        .where(eq(messages.status, 'sending'))
      recovered = true
    }
    await runTick()
  } finally {
    ticking = false
  }
}

async function runTick(): Promise<void> {
  const now = new Date()

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)

  // Backfill step-1 messages for leads added to a running campaign's list after
  // it was launched. Without this, leads imported/created mid-campaign would
  // never be queued (step-1 rows are otherwise only created at launch) and would
  // sit un-contacted forever. enqueueNewLeads is idempotent, so re-running it
  // every tick only ever picks up leads that don't already have a step-1 row.
  const runningCampaigns = await db
    .select({
      id: campaigns.id,
      listId: campaigns.listId,
      minDelaySeconds: campaigns.minDelaySeconds,
      maxDelaySeconds: campaigns.maxDelaySeconds,
      sendWindowStart: campaigns.sendWindowStart,
      sendWindowEnd: campaigns.sendWindowEnd,
      timezone: campaigns.timezone,
      daysOfWeek: campaigns.daysOfWeek,
    })
    .from(campaigns)
    .where(and(eq(campaigns.status, 'running'), isNotNull(campaigns.listId)))

  for (const campaign of runningCampaigns) {
    try {
      const added = await enqueueNewLeads(campaign)
      if (added > 0) {
        console.log(
          `[Lightreach] Enqueued ${added} new lead(s) for running campaign ${campaign.id}`,
        )
      }
    } catch (err) {
      console.error(
        `[Lightreach] Failed to enqueue new leads for campaign ${campaign.id}:`,
        err,
      )
    }
  }

  // Find due queued messages for running campaigns, oldest-due first so a
  // backlog doesn't starve messages that have been waiting the longest.
  const due = await db
    .select({
      msgId: messages.id,
      campaignId: messages.campaignId,
      leadId: messages.leadId,
      stepPosition: messages.stepPosition,
      attempts: messages.attempts,
      sequenceId: campaigns.sequenceId,
      sendWindowStart: campaigns.sendWindowStart,
      sendWindowEnd: campaigns.sendWindowEnd,
      timezone: campaigns.timezone,
      daysOfWeek: campaigns.daysOfWeek,
      dailyCap: campaigns.dailyCap,
      minDelaySeconds: campaigns.minDelaySeconds,
      maxDelaySeconds: campaigns.maxDelaySeconds,
    })
    .from(messages)
    .innerJoin(campaigns, eq(messages.campaignId, campaigns.id))
    .where(
      and(
        eq(messages.status, 'queued'),
        isNotNull(messages.scheduledAt),
        lte(messages.scheduledAt, now),
        eq(campaigns.status, 'running'),
      ),
    )
    .orderBy(asc(messages.scheduledAt))
    .limit(BATCH_SIZE)

  if (due.length === 0) return

  // Load today's sent counts per connection (server-day approximation — a
  // connection can be shared across campaigns in different timezones).
  const sentTodayRows = await db
    .select({
      connectionId: messages.connectionId,
      count: sql<number>`count(*)`,
    })
    .from(messages)
    .where(and(eq(messages.status, 'sent'), gte(messages.sentAt, todayStart)))
    .groupBy(messages.connectionId)

  const sentTodayByConnection: Record<number, number> = {}
  for (const row of sentTodayRows) {
    if (row.connectionId != null) sentTodayByConnection[row.connectionId] = row.count
  }

  const connCache = new Map<number, ConnRow[]>()
  const touchedCampaignIds = new Set<number>()
  let sentAnyThisTick = false

  for (const msg of due) {
    // campaignId is guaranteed non-null by the innerJoin above, but the column
    // is nullable in the schema (manual replies have no campaign). Guard here
    // to narrow the TypeScript type for the rest of the loop.
    if (msg.campaignId == null) continue

    touchedCampaignIds.add(msg.campaignId)
    const iterNow = new Date()

    // Skip if outside send window
    if (
      !isWithinSendWindow(
        iterNow,
        msg.timezone,
        msg.sendWindowStart,
        msg.sendWindowEnd,
        msg.daysOfWeek ?? [1, 2, 3, 4, 5],
      )
    ) {
      continue
    }

    // Check campaign daily cap using the campaign's own timezone boundary
    const campaignTodayStart = startOfDayInTimezone(iterNow, msg.timezone)
    const [capRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.campaignId, msg.campaignId),
          eq(messages.status, 'sent'),
          gte(messages.sentAt, campaignTodayStart),
        ),
      )

    if (capRow && capRow.count >= msg.dailyCap) continue

    // Load campaign connections (cached per campaign)
    if (!connCache.has(msg.campaignId)) {
      const rows = await db
        .select({
          id: connections.id,
          status: connections.status,
          dailyLimit: connections.dailyLimit,
          consecutiveFailures: connections.consecutiveFailures,
          smtpHost: connections.smtpHost,
          smtpPort: connections.smtpPort,
          smtpSecure: connections.smtpSecure,
          smtpUser: connections.smtpUser,
          smtpPassEncrypted: connections.smtpPassEncrypted,
          fromName: connections.fromName,
          fromEmail: connections.fromEmail,
        })
        .from(campaignConnections)
        .innerJoin(connections, eq(campaignConnections.connectionId, connections.id))
        .where(eq(campaignConnections.campaignId, msg.campaignId))

      connCache.set(msg.campaignId, rows)
    }

    const campaignConns = connCache.get(msg.campaignId)!

    // Pick next connection via round-robin (cursor persists across ticks)
    const pickResult = pickNext(campaignConns, {
      sentTodayByConnection,
      lastUsedConnectionId: lastUsedConnectionByCampaign.get(msg.campaignId) ?? null,
    })
    if (!pickResult) {
      // All mailboxes are at capacity for today — defer to tomorrow rather
      // than dropping the message permanently.
      await db
        .update(messages)
        .set({ scheduledAt: new Date(iterNow.getTime() + 24 * 60 * 60 * 1000) })
        .where(eq(messages.id, msg.msgId))
      continue
    }

    lastUsedConnectionByCampaign.set(msg.campaignId, pickResult.connectionId)
    sentTodayByConnection[pickResult.connectionId] = pickResult.newSentCount

    const chosenConn = campaignConns.find((c) => c.id === pickResult.connectionId)!

    // Load lead
    const [lead] = await db.select().from(leads).where(eq(leads.id, msg.leadId))
    if (!lead) {
      await db
        .update(messages)
        .set({ status: 'skipped' })
        .where(eq(messages.id, msg.msgId))
      continue
    }

    // Skip if lead already replied, bounced, or unsubscribed — stop sequence
    if (lead.status === 'bounced' || lead.status === 'replied' || lead.status === 'unsubscribed') {
      await db
        .update(messages)
        .set({ status: 'skipped' })
        .where(eq(messages.id, msg.msgId))
      continue
    }

    // Skip if the address or its whole domain is suppressed. Checked at send
    // time, so entries added after launch (or via another list) still apply.
    if (await isSuppressed(lead.email)) {
      await db
        .update(messages)
        .set({ status: 'skipped', error: 'Suppressed' })
        .where(and(eq(messages.leadId, msg.leadId), eq(messages.status, 'queued')))
      continue
    }

    // Skip if campaign has no sequence
    if (!msg.sequenceId) {
      await db
        .update(messages)
        .set({ status: 'skipped' })
        .where(eq(messages.id, msg.msgId))
      continue
    }

    // Load sequence step
    const [step] = await db
      .select()
      .from(sequenceSteps)
      .where(
        and(
          eq(sequenceSteps.sequenceId, msg.sequenceId),
          eq(sequenceSteps.position, msg.stepPosition),
        ),
      )

    if (!step) {
      await db
        .update(messages)
        .set({ status: 'skipped' })
        .where(eq(messages.id, msg.msgId))
      continue
    }

    // Render subject + body with spintax and variable substitution
    const vars = {
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      company: lead.company,
      openingLine: lead.openingLine,
      ...(lead.customFields ?? {}),
    }

    // Threading: a follow-up flagged sameThread is delivered as a reply to the
    // lead's most recent sent message in this campaign, so it lands inside the
    // same inbox conversation instead of arriving as a brand-new email.
    let threadInReplyTo: string | undefined
    let threadReferences: string | undefined
    let threadSubject: string | undefined
    if (step.sameThread && msg.stepPosition > 1) {
      const [parent] = await db
        .select({
          messageId: messages.messageId,
          renderedSubject: messages.renderedSubject,
        })
        .from(messages)
        .where(
          and(
            eq(messages.campaignId, msg.campaignId),
            eq(messages.leadId, msg.leadId),
            eq(messages.status, 'sent'),
            isNotNull(messages.messageId),
            lt(messages.stepPosition, msg.stepPosition),
          ),
        )
        .orderBy(desc(messages.stepPosition))
        .limit(1)

      if (parent?.messageId) {
        // Stored IDs are normalized without angle brackets — re-wrap for the header.
        const parentId = `<${parent.messageId}>`
        threadInReplyTo = parentId
        threadReferences = parentId
        const base = (parent.renderedSubject ?? '')
          .replace(/^\s*(re:\s*)+/i, '')
          .trim()
        threadSubject = `Re: ${base}`
      }
    }

    const renderedSubject =
      threadSubject ?? renderVariables(expandSpintax(step.subject), vars)
    const renderedPlainBody = appendUnsubscribeFooter(renderVariables(expandSpintax(step.body), vars))
    const renderedBody = renderedPlainBody.replace(/\n/g, '<br>')

    // Decrypt SMTP password
    let smtpPass: string
    try {
      smtpPass = decrypt(chosenConn.smtpPassEncrypted)
    } catch {
      await db
        .update(messages)
        .set({ status: 'failed', error: 'Failed to decrypt SMTP credentials' })
        .where(eq(messages.id, msg.msgId))
      continue
    }

    // Atomically claim the row so an overlapping run (or a future multi-instance
    // deployment) can never send the same queued message twice.
    const claimed = await db
      .update(messages)
      .set({ status: 'sending' })
      .where(and(eq(messages.id, msg.msgId), eq(messages.status, 'queued')))
      .returning({ id: messages.id })
    if (claimed.length === 0) continue

    // Jitter between sends (skip on the very first send of the tick so a
    // single due message isn't needlessly delayed).
    if (sentAnyThisTick) {
      await sleep(randomDelayMs(msg.minDelaySeconds, msg.maxDelaySeconds))
    }
    sentAnyThisTick = true

    // The send window may have closed while we were sleeping/waiting.
    const preSendNow = new Date()
    if (
      !isWithinSendWindow(
        preSendNow,
        msg.timezone,
        msg.sendWindowStart,
        msg.sendWindowEnd,
        msg.daysOfWeek ?? [1, 2, 3, 4, 5],
      )
    ) {
      await db
        .update(messages)
        .set({ status: 'queued' })
        .where(eq(messages.id, msg.msgId))
      continue
    }

    // Message-ID rooted at the sender's own domain — a non-routable placeholder
    // domain is a well-known spam signal.
    const outboundMessageId = buildMessageId(chosenConn.fromEmail, randomUUID())

    // Send email
    try {
      await sendMail(
        {
          smtpHost: chosenConn.smtpHost,
          smtpPort: chosenConn.smtpPort,
          smtpSecure: chosenConn.smtpSecure,
          smtpUser: chosenConn.smtpUser,
          smtpPass,
        },
        {
          fromName: chosenConn.fromName,
          fromEmail: chosenConn.fromEmail,
          to: lead.email,
          subject: renderedSubject,
          html: renderedBody,
          text: renderedPlainBody,
          messageId: outboundMessageId,
          inReplyTo: threadInReplyTo,
          references: threadReferences,
          headers: buildUnsubscribeHeaders({
            email: lead.email,
            messageRowId: msg.msgId,
            mailbox: chosenConn.fromEmail,
          }),
        },
      )

      await db
        .update(messages)
        .set({
          status: 'sent',
          sentAt: new Date(),
          connectionId: pickResult.connectionId,
          renderedSubject,
          renderedBody,
          messageId: normalizeMessageId(outboundMessageId),
        })
        .where(eq(messages.id, msg.msgId))

      if (chosenConn.consecutiveFailures > 0) {
        await db
          .update(connections)
          .set({ consecutiveFailures: 0 })
          .where(eq(connections.id, pickResult.connectionId))
      }

      if (lead.status === 'new') {
        await db.update(leads).set({ status: 'contacted' }).where(eq(leads.id, lead.id))
      }

      // Enqueue the next sequence step, if any, offset by its configured delay
      // (plus a little jitter so same-day follow-ups don't all land at once).
      const [nextStep] = await db
        .select({ position: sequenceSteps.position, delayDays: sequenceSteps.delayDays })
        .from(sequenceSteps)
        .where(
          and(
            eq(sequenceSteps.sequenceId, msg.sequenceId),
            eq(sequenceSteps.position, msg.stepPosition + 1),
          ),
        )

      if (nextStep) {
        const jitterMs = randomDelayMs(0, msg.maxDelaySeconds)
        await db.insert(messages).values({
          campaignId: msg.campaignId,
          leadId: msg.leadId,
          stepPosition: nextStep.position,
          status: 'queued',
          scheduledAt: new Date(Date.now() + nextStep.delayDays * 86_400_000 + jitterMs),
        })
      }

      console.log(
        `[Lightreach] Sent message ${msg.msgId} to ${lead.email} via connection ${pickResult.connectionId}`,
      )
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Lightreach] Failed to send message ${msg.msgId}:`, errMsg)

      const failure = classifySendFailure(err)
      if (failure) {
        await db
          .update(messages)
          .set({ status: 'failed', error: errMsg })
          .where(eq(messages.id, msg.msgId))
        await db
          .update(leads)
          .set({ status: 'bounced' })
          .where(eq(leads.id, msg.leadId))
        await db
          .update(messages)
          .set({ status: 'skipped' })
          .where(and(eq(messages.leadId, msg.leadId), eq(messages.status, 'queued')))
        // A block (policy, spam) is not proof the address is dead, so only a
        // hard bounce goes on the suppression list.
        if (failure === 'hard') {
          await suppress({
            kind: 'email',
            value: lead.email,
            reason: 'bounced',
            leadId: msg.leadId,
            messageId: msg.msgId,
          })
        }
        console.log(
          `[Lightreach] ${failure === 'hard' ? 'Hard bounce' : 'Recipient rejected'} for lead ${msg.leadId} (message ${msg.msgId}) — lead marked bounced, future messages skipped`,
        )
      } else {
        // Transient failure: retry with backoff instead of failing terminally.
        const attempts = msg.attempts + 1
        if (attempts < MAX_ATTEMPTS) {
          await db
            .update(messages)
            .set({
              status: 'queued',
              attempts,
              error: errMsg,
              scheduledAt: new Date(Date.now() + RETRY_BACKOFF_BASE_MS * 2 ** (attempts - 1)),
            })
            .where(eq(messages.id, msg.msgId))
        } else {
          await db
            .update(messages)
            .set({ status: 'failed', attempts, error: errMsg })
            .where(eq(messages.id, msg.msgId))
        }

        // A single transient error shouldn't take a mailbox out of rotation —
        // only disable it after several failures in a row.
        const [updatedConn] = await db
          .update(connections)
          .set({
            consecutiveFailures: sql`${connections.consecutiveFailures} + 1`,
            lastError: errMsg,
          })
          .where(eq(connections.id, pickResult.connectionId))
          .returning({ consecutiveFailures: connections.consecutiveFailures })

        if (updatedConn && updatedConn.consecutiveFailures >= CONNECTION_ERROR_THRESHOLD) {
          await db
            .update(connections)
            .set({ status: 'error' })
            .where(eq(connections.id, pickResult.connectionId))
          // Evict from this tick's cache so it isn't picked again while still
          // marked 'active' in the stale in-memory snapshot.
          connCache.set(
            msg.campaignId,
            campaignConns.filter((c) => c.id !== pickResult.connectionId),
          )
        }
      }
    }
  }

  // A running campaign with nothing left queued has finished sending.
  for (const campaignId of touchedCampaignIds) {
    const [remaining] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(and(eq(messages.campaignId, campaignId), eq(messages.status, 'queued')))

    if (remaining && remaining.count === 0) {
      await db
        .update(campaigns)
        .set({ status: 'completed' })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, 'running')))
    }
  }
}
