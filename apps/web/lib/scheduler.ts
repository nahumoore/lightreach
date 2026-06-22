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
import { sendMail } from '@workspace/core/email/transport'
import { pickNext, isWithinSendWindow } from '@workspace/core/rotation'
import { expandSpintax } from '@workspace/core/spintax'
import { renderVariables } from '@workspace/core/variables'
import { eq, and, lte, gte, isNotNull, sql } from 'drizzle-orm'

const TICK_MS = 60_000
const BATCH_SIZE = 10

function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null
  return id.replace(/^<|>$/g, '').trim() || null
}

function isHardBounce(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as { responseCode?: number }).responseCode
  if (code !== undefined && code >= 550 && code <= 554) return true
  if (/\b55[0-4]\b/.test(msg)) return true
  if (/\b(user.*unknown|mailbox.*unavailable|no.*such.*user|address.*rejected|does not exist|invalid.*mailbox)\b/i.test(msg)) return true
  return false
}

let schedulerHandle: ReturnType<typeof setInterval> | null = null

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
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPassEncrypted: string
  fromName: string
  fromEmail: string
}

async function tick(): Promise<void> {
  const now = new Date()

  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)

  // Find due queued messages for running campaigns
  const due = await db
    .select({
      msgId: messages.id,
      campaignId: messages.campaignId,
      leadId: messages.leadId,
      stepPosition: messages.stepPosition,
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
    .limit(BATCH_SIZE)

  if (due.length === 0) return

  // Load today's sent counts per connection
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
  let lastUsedConnectionId: number | null = null

  for (const msg of due) {
    // Skip if outside send window
    if (
      !isWithinSendWindow(
        now,
        msg.timezone,
        msg.sendWindowStart,
        msg.sendWindowEnd,
        msg.daysOfWeek ?? [1, 2, 3, 4, 5],
      )
    ) {
      continue
    }

    // Check campaign daily cap
    const [capRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(
        and(
          eq(messages.campaignId, msg.campaignId),
          eq(messages.status, 'sent'),
          gte(messages.sentAt, todayStart),
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

    // Pick next connection via round-robin
    const pickResult = pickNext(campaignConns, { sentTodayByConnection, lastUsedConnectionId })
    if (!pickResult) {
      await db
        .update(messages)
        .set({ status: 'skipped' })
        .where(eq(messages.id, msg.msgId))
      continue
    }

    lastUsedConnectionId = pickResult.connectionId
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

    // Skip if lead already replied or bounced — stop sequence
    if (lead.status === 'bounced' || lead.status === 'replied') {
      await db
        .update(messages)
        .set({ status: 'skipped' })
        .where(eq(messages.id, msg.msgId))
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

    const renderedSubject = renderVariables(expandSpintax(step.subject), vars)
    const renderedBody = renderVariables(expandSpintax(step.body), vars)

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

    // Send email
    try {
      const { messageId: sentMessageId } = await sendMail(
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
          messageId: normalizeMessageId(sentMessageId),
        })
        .where(eq(messages.id, msg.msgId))

      console.log(
        `[Lightreach] Sent message ${msg.msgId} to ${lead.email} via connection ${pickResult.connectionId}`,
      )
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Lightreach] Failed to send message ${msg.msgId}:`, errMsg)

      await db
        .update(messages)
        .set({ status: 'failed', error: errMsg })
        .where(eq(messages.id, msg.msgId))

      if (isHardBounce(err)) {
        await db
          .update(leads)
          .set({ status: 'bounced' })
          .where(eq(leads.id, msg.leadId))
        await db
          .update(messages)
          .set({ status: 'skipped' })
          .where(and(eq(messages.leadId, msg.leadId), eq(messages.status, 'queued')))
        console.log(
          `[Lightreach] Hard bounce for lead ${msg.leadId} (message ${msg.msgId}) — lead marked bounced, future messages skipped`,
        )
      } else {
        await db
          .update(connections)
          .set({ status: 'error', lastError: errMsg })
          .where(eq(connections.id, pickResult.connectionId))
      }
    }
  }
}
