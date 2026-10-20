import { db } from '@workspace/db'
import { connections, warmupEmails, appSettings } from '@workspace/db/schema'
import type { Connection, NewWarmupEmail } from '@workspace/db/schema'
import { decrypt } from '@workspace/core/crypto'
import { sendMail, buildMessageId } from '@workspace/core/email/transport'
import { resolveImapConfig, rescueWarmupMessages } from '@workspace/core/email/imap'
import type { WarmupPlacement } from '@workspace/core/email/imap'
import {
  warmupDailyTarget,
  warmupDaysSinceStart,
  isWarmupSendDue,
  pickWarmupRecipient,
  shouldWarmupReply,
  composeWarmupEmail,
  composeWarmupReply,
} from '@workspace/core/warmup'
import type { WarmupContent } from '@workspace/core/warmup'
import { expandSpintax } from '@workspace/core/spintax'
import { eq, and, gte, lt, isNull, inArray, or, like, notLike, max, desc, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'

const TICK_MS = 5 * 60_000
const DAY_MS = 86_400_000
/** A warmup email the recipient still can't find after this long is recorded as 'missing'. */
const MISSING_AFTER_MS = DAY_MS
/** A row still 'sending' after this long was cut off by a crash or restart. Far longer
 *  than any real send (SMTP timeouts are well under a minute), so it is never in flight. */
const STUCK_SENDING_MS = 10 * 60_000
/** Overlap guard. A pass that outlives this is assumed dead and its lease can be taken. */
const LEASE_KEY = 'warmup_lease'
const LEASE_TTL_MS = 30 * 60_000
const ERROR_PREFIX = 'Warmup:'

let warmupHandle: ReturnType<typeof setInterval> | null = null

export function startWarmup(): void {
  if (warmupHandle) {
    console.log('[Lightreach] Warmup already running.')
    return
  }

  console.log('[Lightreach] Warmup started. Tick interval:', TICK_MS, 'ms')

  // The process just started, so no pass can be running: a lease left behind by
  // a crash or restart would otherwise block warmup until it expires.
  db.delete(appSettings).where(eq(appSettings.key, LEASE_KEY)).run()

  warmupHandle = setInterval(() => {
    tick({ force: false, recoverStuck: true }).catch((err) => {
      console.error('[Lightreach] Warmup tick error:', err)
    })
  }, TICK_MS)

  tick({ force: false, recoverStuck: true }).catch((err) => {
    console.error('[Lightreach] Warmup startup tick error:', err)
  })

  warmupHandle.unref()
}

export function stopWarmup(): void {
  if (warmupHandle) {
    clearInterval(warmupHandle)
    warmupHandle = null
    console.log('[Lightreach] Warmup stopped.')
  }
}

export type WarmupRunResult = { sent: number; replied: number; found: number }

/**
 * Run one warmup pass right now, skipping the through-the-day pacing. Each
 * mailbox still sends at most one new email per pass and never more than
 * today's ramp target. Returns null if a pass is already in progress.
 */
export async function runWarmupNow(): Promise<WarmupRunResult | null> {
  return tick({ force: true, recoverStuck: false })
}

/**
 * Take the warmup lease: an app_settings row holding `<expiresAtMs>:<token>`,
 * checked and written in one synchronous transaction. Next loads this module
 * separately for instrumentation and for server actions / the MCP route, so an
 * in-memory flag can't stop a manual run from overlapping the background tick.
 * Returns the lease value to release with, or null if another pass holds it.
 */
function acquireLease(): string | null {
  const now = Date.now()
  const value = `${now + LEASE_TTL_MS}:${randomUUID()}`
  return db.transaction((tx) => {
    const current = tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, LEASE_KEY))
      .get()
    if (current && Number(current.value.split(':')[0]) > now) return null
    tx.insert(appSettings)
      .values({ key: LEASE_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } })
      .run()
    return value
  })
}

/** Release only our own lease, never one a later pass took over after ours expired. */
async function releaseLease(value: string): Promise<void> {
  await db
    .delete(appSettings)
    .where(and(eq(appSettings.key, LEASE_KEY), eq(appSettings.value, value)))
}

/** Serial wrapper: SMTP sends plus one IMAP session per recipient can outlast an interval. */
async function tick(opts: { force: boolean; recoverStuck: boolean }): Promise<WarmupRunResult | null> {
  const lease = acquireLease()
  if (!lease) return null
  try {
    if (opts.recoverStuck) {
      // A row left in 'sending' by a crash mid-send may or may not have gone out.
      // Never resend it: it already counts toward today's target, so a restart
      // can't push a mailbox over its ramp. Background ticks only, and only rows
      // old enough that no live send can still own them.
      await db
        .update(warmupEmails)
        .set({ status: 'failed', error: 'Interrupted before the send was confirmed' })
        .where(
          and(
            eq(warmupEmails.status, 'sending'),
            lt(warmupEmails.createdAt, new Date(Date.now() - STUCK_SENDING_MS)),
          ),
        )
    }
    return await runTick(opts)
  } finally {
    await releaseLease(lease)
  }
}

/** Mailboxes that take part in warmup right now: active, opted in, IMAP on. */
function isEligible(conn: Connection): boolean {
  return conn.status === 'active' && conn.warmupEnabled && conn.imapEnabled
}

function startOfToday(now: Date): Date {
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  return todayStart
}

function normalizeMessageId(id: string): string {
  return id.replace(/^<|>$/g, '').trim()
}

async function recordWarmupError(connectionId: number, errMsg: string): Promise<void> {
  // Deliberately leaves consecutiveFailures alone: warmup trouble must never
  // flip a mailbox to 'error' and pull it out of campaign rotation. Never
  // overwrites a campaign/IMAP error, which matters more than a warmup one.
  await db
    .update(connections)
    .set({ lastError: `${ERROR_PREFIX} ${errMsg}` })
    .where(
      and(
        eq(connections.id, connectionId),
        or(isNull(connections.lastError), like(connections.lastError, `${ERROR_PREFIX}%`)),
      ),
    )
}

/** Clear a stale warmup error after a success of the same kind. An SMTP success
 *  leaves an IMAP error in place and vice versa, and non-warmup errors are never touched. */
async function clearWarmupError(connectionId: number, kind: 'send' | 'imap'): Promise<void> {
  const imapPattern = `${ERROR_PREFIX} IMAP:%`
  await db
    .update(connections)
    .set({ lastError: null })
    .where(
      and(
        eq(connections.id, connectionId),
        kind === 'imap'
          ? like(connections.lastError, imapPattern)
          : and(like(connections.lastError, `${ERROR_PREFIX}%`), notLike(connections.lastError, imapPattern)),
      ),
    )
}

async function runTick(opts: { force: boolean }): Promise<WarmupRunResult> {
  const result: WarmupRunResult = { sent: 0, replied: 0, found: 0 }
  const allConns = await db.select().from(connections)
  const eligible = allConns.filter(isEligible)

  // Warmup is mailbox-to-mailbox: with fewer than two there is nobody to write to.
  if (eligible.length >= 2) {
    result.sent = await sendStep(eligible, opts.force)
  }

  const receive = await receiveStep(allConns, eligible)
  result.replied = receive.replied
  result.found = receive.found
  return result
}

// ---------------------------------------------------------------------------
// Send step
// ---------------------------------------------------------------------------

/**
 * Insert the warmup row before sending, inside one synchronous transaction that
 * re-counts today's sends. That makes the daily target a hard cap even if two
 * passes overlap (e.g. a manual trigger during a background tick), and records
 * the Message-ID before the mail can reach the recipient's inbox poller.
 *
 * Returns the new row id, or null when the sender is already at today's target.
 */
function claimSendSlot(row: NewWarmupEmail, target: number, todayStart: Date): number | null {
  return db.transaction((tx) => {
    const used = tx
      .select({ n: sql<number>`count(*)` })
      .from(warmupEmails)
      .where(
        and(
          eq(warmupEmails.fromConnectionId, row.fromConnectionId),
          isNull(warmupEmails.parentId),
          gte(warmupEmails.createdAt, todayStart),
        ),
      )
      .get()
    if ((used?.n ?? 0) >= target) return null
    const inserted = tx.insert(warmupEmails).values(row).returning({ id: warmupEmails.id }).get()
    return inserted?.id ?? null
  })
}

async function sendStep(eligible: Connection[], force: boolean): Promise<number> {
  const now = new Date()
  const todayStart = startOfToday(now)
  const fractionOfDay = (now.getTime() - todayStart.getTime()) / DAY_MS

  // Every warmup row created today counts (sending, sent and failed alike), so
  // a restart or a flaky SMTP server can never push a mailbox past its ramp.
  const sentTodayRows = await db
    .select({ connectionId: warmupEmails.fromConnectionId, n: sql<number>`count(*)` })
    .from(warmupEmails)
    .where(and(isNull(warmupEmails.parentId), gte(warmupEmails.createdAt, todayStart)))
    .groupBy(warmupEmails.fromConnectionId)
  const sentToday = new Map(sentTodayRows.map((r) => [r.connectionId, Number(r.n)]))

  let sent = 0
  for (const sender of eligible) {
    try {
      const target = warmupDailyTarget(sender, now)
      const already = sentToday.get(sender.id) ?? 0
      if (already >= target) continue
      if (!force && !isWarmupSendDue(already, target, fractionOfDay)) continue

      const lastMailed = await db
        .select({ connectionId: warmupEmails.toConnectionId, at: max(warmupEmails.createdAt) })
        .from(warmupEmails)
        .where(and(eq(warmupEmails.fromConnectionId, sender.id), isNull(warmupEmails.parentId)))
        .groupBy(warmupEmails.toConnectionId)
      const lastMailedAt = new Map(lastMailed.map((r) => [r.connectionId, r.at]))

      const recipientId = pickWarmupRecipient(
        sender.id,
        eligible.map((c) => ({ id: c.id, lastMailedAt: lastMailedAt.get(c.id) ?? null })),
      )
      const recipient = eligible.find((c) => c.id === recipientId)
      if (!recipient) continue

      const content = composeWarmupEmail(expandSpintax, {
        fromName: sender.fromName,
        toName: recipient.fromName,
      })
      const ok = await sendWarmup(sender, recipient, content, { target, todayStart })
      if (ok) sent++
    } catch (err) {
      // One broken mailbox (or one deleted mid-run) must not stop the others.
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Lightreach] Warmup send error for connection ${sender.id}:`, errMsg)
    }
  }
  return sent
}

/**
 * Send one warmup email (or reply) and record the outcome on its warmup row.
 * New emails pass `target` so the slot is claimed against today's cap; replies
 * pass `parent` and are claimed by the caller instead.
 */
async function sendWarmup(
  sender: Connection,
  recipient: Connection,
  content: WarmupContent,
  opts: { target: number; todayStart: Date } | { parent: { id: number; messageId: string } },
): Promise<boolean> {
  const outboundMessageId = buildMessageId(sender.fromEmail, randomUUID())
  const row: NewWarmupEmail = {
    fromConnectionId: sender.id,
    toConnectionId: recipient.id,
    parentId: 'parent' in opts ? opts.parent.id : null,
    messageId: normalizeMessageId(outboundMessageId),
    subject: content.subject,
    status: 'sending',
  }

  let rowId: number | null
  if ('parent' in opts) {
    const [inserted] = await db.insert(warmupEmails).values(row).returning({ id: warmupEmails.id })
    rowId = inserted?.id ?? null
  } else {
    rowId = claimSendSlot(row, opts.target, opts.todayStart)
  }
  if (rowId == null) return false

  const parentHeader = 'parent' in opts ? `<${opts.parent.messageId}>` : undefined

  try {
    await sendMail(
      {
        smtpHost: sender.smtpHost,
        smtpPort: sender.smtpPort,
        smtpSecure: sender.smtpSecure,
        smtpUser: sender.smtpUser,
        smtpPass: decrypt(sender.smtpPassEncrypted),
      },
      {
        fromName: sender.fromName,
        fromEmail: sender.fromEmail,
        to: recipient.fromEmail,
        subject: content.subject,
        html: content.text.replace(/\n/g, '<br>'),
        text: content.text,
        messageId: outboundMessageId,
        inReplyTo: parentHeader,
        references: parentHeader,
      },
    )

    await db
      .update(warmupEmails)
      .set({ status: 'sent', sentAt: new Date() })
      .where(eq(warmupEmails.id, rowId))
    await clearWarmupError(sender.id, 'send')
    console.log(
      `[Lightreach] Warmup ${'parent' in opts ? 'reply' : 'email'} ${rowId} sent from connection ${sender.id} to connection ${recipient.id}`,
    )
    return true
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[Lightreach] Warmup send failed for connection ${sender.id}:`, errMsg)
    await db
      .update(warmupEmails)
      .set({ status: 'failed', error: errMsg })
      .where(eq(warmupEmails.id, rowId))
    await recordWarmupError(sender.id, errMsg)
    return false
  }
}

// ---------------------------------------------------------------------------
// Receive step
// ---------------------------------------------------------------------------

/**
 * For every mailbox with warmup mail waiting, open one IMAP session, find each
 * message (rescuing it from spam), record where it landed and maybe reply.
 *
 * Runs for any active IMAP mailbox with pending warmup mail, not only eligible
 * ones, so switching warmup off doesn't strand mail it already received in spam.
 * Replies only come from mailboxes still eligible for warmup. Anything still
 * unfound a day after sending is then recorded as 'missing', whatever state its
 * recipient is in (paused, IMAP off, warmup off, or failing to connect).
 */
async function receiveStep(
  allConns: Connection[],
  eligible: Connection[],
): Promise<{ replied: number; found: number }> {
  const now = new Date()
  const pending = await db
    .select()
    .from(warmupEmails)
    .where(and(eq(warmupEmails.status, 'sent'), isNull(warmupEmails.handledAt)))

  if (pending.length === 0) return { replied: 0, found: 0 }

  const byId = new Map(allConns.map((c) => [c.id, c]))
  const eligibleIds = new Set(eligible.map((c) => c.id))
  const byRecipient = new Map<number, typeof pending>()
  for (const row of pending) {
    const list = byRecipient.get(row.toConnectionId) ?? []
    list.push(row)
    byRecipient.set(row.toConnectionId, list)
  }

  let replied = 0
  let found = 0
  for (const [recipientId, rows] of byRecipient) {
    const recipient = byId.get(recipientId)
    // Deleted mid-run (its rows cascade away) or not reachable over IMAP right now.
    if (!recipient || recipient.status !== 'active' || !recipient.imapEnabled) continue

    let placements: Map<string, WarmupPlacement>
    try {
      const imapConfig = resolveImapConfig(recipient, decrypt)
      if (!imapConfig) continue
      placements = await rescueWarmupMessages(
        imapConfig,
        rows.map((r) => r.messageId),
      )
    } catch (err) {
      // An IMAP failure on one mailbox must not stop the others.
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Lightreach] Warmup IMAP error for connection ${recipientId}:`, errMsg)
      await recordWarmupError(recipientId, `IMAP: ${errMsg}`)
      continue
    }

    for (const row of rows) {
      try {
        const landedIn = placements.get(row.messageId)
        if (!landedIn) continue

        // Claim the row so an overlapping pass can't record it (or reply) twice.
        const claimed = await db
          .update(warmupEmails)
          .set({ landedIn, handledAt: now })
          .where(and(eq(warmupEmails.id, row.id), isNull(warmupEmails.handledAt)))
          .returning({ id: warmupEmails.id })
        if (claimed.length === 0) continue
        found++

        // Never reply to a reply, so threads stay two messages long.
        if (row.parentId != null) continue
        if (!eligibleIds.has(recipient.id)) continue
        const original = byId.get(row.fromConnectionId)
        if (!original || original.status !== 'active') continue
        if (!shouldWarmupReply(recipient.warmupReplyRate)) continue

        const content = composeWarmupReply(expandSpintax, {
          fromName: recipient.fromName,
          toName: original.fromName,
          subject: row.subject,
        })
        const ok = await sendWarmup(recipient, original, content, {
          parent: { id: row.id, messageId: row.messageId },
        })
        if (ok) {
          replied++
          await db.update(warmupEmails).set({ repliedAt: new Date() }).where(eq(warmupEmails.id, row.id))
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[Lightreach] Warmup receive error for warmup email ${row.id}:`, errMsg)
      }
    }

    await clearWarmupError(recipient.id, 'imap')
  }

  await db
    .update(warmupEmails)
    .set({ landedIn: 'missing', handledAt: now })
    .where(
      and(
        eq(warmupEmails.status, 'sent'),
        isNull(warmupEmails.handledAt),
        lt(warmupEmails.sentAt, new Date(now.getTime() - MISSING_AFTER_MS)),
      ),
    )

  return { replied, found }
}

// ---------------------------------------------------------------------------
// Status (shared by the connections page and the MCP tools)
// ---------------------------------------------------------------------------

export type WarmupState = 'off' | 'waiting' | 'running'

export type WarmupStatus = {
  connectionId: number
  label: string
  fromEmail: string
  enabled: boolean
  startVolume: number
  dailyIncrease: number
  maxVolume: number
  replyRate: number
  startedAt: string | null
  /** 1-based day of the current ramp, null while warmup is off */
  rampDay: number | null
  state: WarmupState
  /** Why a mailbox with warmup on isn't sending yet */
  reason: string | null
  todayTarget: number
  sentToday: number
  repliesToday: number
  /** Where this mailbox's own warmup emails (and replies) landed over the last 7 days */
  last7Days: { sent: number; inbox: number; spam: number; missing: number; pending: number }
  /** The latest warmup error on this mailbox, if any */
  lastError: string | null
}

/**
 * Warmup status for every mailbox, or just one when `connectionId` is given.
 */
export async function getWarmupStatus(connectionId?: number): Promise<WarmupStatus[]> {
  const now = new Date()
  const todayStart = startOfToday(now)
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS)

  const allConns = await db.select().from(connections).orderBy(connections.createdAt)
  const eligibleCount = allConns.filter(isEligible).length

  const [todayRows, weekRows] = await Promise.all([
    db
      .select({
        connectionId: warmupEmails.fromConnectionId,
        emails: sql<number>`sum(case when ${warmupEmails.parentId} is null then 1 else 0 end)`,
        replies: sql<number>`sum(case when ${warmupEmails.parentId} is not null then 1 else 0 end)`,
      })
      .from(warmupEmails)
      .where(gte(warmupEmails.createdAt, todayStart))
      .groupBy(warmupEmails.fromConnectionId),
    db
      .select({
        connectionId: warmupEmails.fromConnectionId,
        landedIn: warmupEmails.landedIn,
        n: sql<number>`count(*)`,
      })
      .from(warmupEmails)
      .where(and(eq(warmupEmails.status, 'sent'), gte(warmupEmails.createdAt, weekAgo)))
      .groupBy(warmupEmails.fromConnectionId, warmupEmails.landedIn),
  ])

  return allConns
    .filter((c) => connectionId === undefined || c.id === connectionId)
    .map((c) => {
      let state: WarmupState = 'off'
      let reason: string | null = null
      if (c.warmupEnabled) {
        if (!c.imapEnabled) {
          state = 'waiting'
          reason = 'Enable IMAP on this mailbox so warmup can find and rescue its mail'
        } else if (c.status !== 'active') {
          state = 'waiting'
          reason = `Mailbox is ${c.status}`
        } else if (eligibleCount < 2) {
          state = 'waiting'
          reason = 'Waiting for a second warmup mailbox'
        } else {
          state = 'running'
        }
      }

      const today = todayRows.find((r) => r.connectionId === c.id)
      const week = weekRows.filter((r) => r.connectionId === c.id)
      const weekCount = (landedIn: string | null) =>
        week.filter((r) => r.landedIn === landedIn).reduce((sum, r) => sum + Number(r.n), 0)

      return {
        connectionId: c.id,
        label: c.label,
        fromEmail: c.fromEmail,
        enabled: c.warmupEnabled,
        startVolume: c.warmupStartVolume,
        dailyIncrease: c.warmupDailyIncrease,
        maxVolume: c.warmupMaxVolume,
        replyRate: c.warmupReplyRate,
        startedAt: c.warmupStartedAt?.toISOString() ?? null,
        rampDay: c.warmupEnabled ? warmupDaysSinceStart(c, now) + 1 : null,
        state,
        reason,
        todayTarget: c.warmupEnabled ? warmupDailyTarget(c, now) : 0,
        sentToday: Number(today?.emails ?? 0),
        repliesToday: Number(today?.replies ?? 0),
        last7Days: {
          sent: week.reduce((sum, r) => sum + Number(r.n), 0),
          inbox: weekCount('inbox'),
          spam: weekCount('spam'),
          missing: weekCount('missing'),
          pending: weekCount(null),
        },
        lastError: c.lastError?.startsWith(ERROR_PREFIX) ? c.lastError : null,
      }
    })
}

/**
 * Recent warmup emails, newest first, optionally only those a mailbox sent or received.
 */
export async function listWarmupEmails(connectionId: number | undefined, limit: number) {
  return db
    .select()
    .from(warmupEmails)
    .where(
      connectionId !== undefined
        ? or(
            eq(warmupEmails.fromConnectionId, connectionId),
            eq(warmupEmails.toConnectionId, connectionId),
          )
        : undefined,
    )
    .orderBy(desc(warmupEmails.createdAt), desc(warmupEmails.id))
    .limit(limit)
}

/**
 * True when an inbound message is warmup traffic: its own Message-ID, or one it
 * replies to / references, is a warmup email we sent.
 */
export async function isWarmupMessage(email: {
  messageId: string | null
  inReplyTo: string | null
  references: string | null
}): Promise<boolean> {
  const ids = new Set<string>()
  for (const raw of [email.messageId, email.inReplyTo, ...(email.references ?? '').split(/\s+/)]) {
    if (!raw) continue
    const id = normalizeMessageId(raw)
    if (id) ids.add(id)
  }
  if (ids.size === 0) return false

  const [hit] = await db
    .select({ id: warmupEmails.id })
    .from(warmupEmails)
    .where(inArray(warmupEmails.messageId, [...ids]))
    .limit(1)
  return !!hit
}
