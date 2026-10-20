import { db } from '@workspace/db'
import { appSettings, connections, inboundEmails, messages } from '@workspace/db/schema'
import { and, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm'

const TICK_MS = 10 * 60_000
const DAY_MS = 86_400_000

/** Prefix of connections.lastError when the health check paused the mailbox. */
export const HEALTH_ERROR_PREFIX = 'Health:'

export type HealthSettings = {
  /** Bounce rate (percent) at or above which a mailbox is auto-paused. */
  bounceThreshold: number
  /** Rolling window, in days, the bounce rate is measured over. */
  windowDays: number
  /** A mailbox needs at least this many sends in the window before it can be paused. */
  minSends: number
  autoPause: boolean
}

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  bounceThreshold: 5,
  windowDays: 7,
  minSends: 20,
  autoPause: true,
}

const SETTING_KEYS: Record<keyof HealthSettings, string> = {
  bounceThreshold: 'health_bounce_threshold',
  windowDays: 'health_window_days',
  minSends: 'health_min_sends',
  autoPause: 'health_auto_pause',
}

const NUMERIC_RULES = {
  bounceThreshold: {
    ok: (n: number) => n > 0 && n <= 100,
    message: 'Bounce threshold must be greater than 0 and at most 100 (percent)',
  },
  windowDays: {
    ok: (n: number) => Number.isInteger(n) && n >= 1 && n <= 90,
    message: 'Window must be a whole number of days from 1 to 90',
  },
  minSends: {
    ok: (n: number) => Number.isInteger(n) && n >= 1,
    message: 'Minimum sends must be a whole number of 1 or more',
  },
} as const

/** Read the health thresholds. Missing or invalid stored values fall back to the defaults. */
export async function getHealthSettings(): Promise<HealthSettings> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, Object.values(SETTING_KEYS)))
  const stored = new Map(rows.map((r) => [r.key, r.value]))

  const settings = { ...DEFAULT_HEALTH_SETTINGS }
  for (const field of Object.keys(NUMERIC_RULES) as (keyof typeof NUMERIC_RULES)[]) {
    const raw = stored.get(SETTING_KEYS[field])
    const n = raw?.trim() ? Number(raw) : NaN
    if (NUMERIC_RULES[field].ok(n)) settings[field] = n
  }
  const autoPause = stored.get(SETTING_KEYS.autoPause)
  if (autoPause !== undefined) settings.autoPause = autoPause !== 'false'
  return settings
}

/** Merge a partial update into the stored thresholds. Throws on an invalid value. */
export async function setHealthSettings(patch: Partial<HealthSettings>): Promise<HealthSettings> {
  const next = { ...(await getHealthSettings()) }
  for (const field of Object.keys(NUMERIC_RULES) as (keyof typeof NUMERIC_RULES)[]) {
    const value = patch[field]
    if (value === undefined) continue
    if (typeof value !== 'number' || !NUMERIC_RULES[field].ok(value)) {
      throw new Error(NUMERIC_RULES[field].message)
    }
    next[field] = value
  }
  if (patch.autoPause !== undefined) next.autoPause = Boolean(patch.autoPause)

  for (const field of Object.keys(SETTING_KEYS) as (keyof HealthSettings)[]) {
    const value = String(next[field])
    await db
      .insert(appSettings)
      .values({ key: SETTING_KEYS[field], value })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: new Date() },
      })
  }
  return next
}

/**
 * Column values to apply when a user re-activates a paused mailbox: bounces from
 * before now stop counting, the auto-pause marker is cleared, and so is the
 * "Health:" error it left.
 */
export function healthResetPatch() {
  return {
    healthResetAt: new Date(),
    healthPausedAt: null,
    lastError: sql`case when ${connections.lastError} like ${`${HEALTH_ERROR_PREFIX}%`} then null else ${connections.lastError} end`,
  }
}

export type MailboxHealth = {
  connectionId: number
  label: string
  fromEmail: string
  status: string
  /** When bounces last started counting afresh (a resume). Null if never reset. */
  resetAt: string | null
  /** Effective start of the measured window: the later of the rolling window and the last health reset. */
  since: string
  windowDays: number
  /** Campaign emails sent from this mailbox in the window, including SMTP-rejected hard bounces. */
  sent: number
  /** smtpBounces + inboxBounces. */
  bounces: number
  /** Hard bounces rejected at send time (SMTP 550-554). */
  smtpBounces: number
  /** Bounce notifications (DSNs) found in this mailbox's IMAP inbox. */
  inboxBounces: number
  /** Percent, 0 to 100, one decimal. */
  bounceRate: number
  /** Without IMAP only SMTP-time rejections are visible, so the rate is a lower bound. */
  imapEnabled: boolean
  consecutiveFailures: number
  lastError: string | null
  /** SPF/DKIM/DMARC from the last DNS check. Null if never checked. */
  dns: { spf: boolean; dkim: boolean; dmarc: boolean } | null
  /** Paused by the health check (not by the user). Based on healthPausedAt, not lastError. */
  autoPaused: boolean
  /** When the health check paused it. Null unless autoPaused. */
  pausedAt: string | null
  /** The "Health:" explanation, if lastError still holds it (other writers can overwrite lastError). */
  pauseReason: string | null
  /** Enough sends and a bounce rate at or above the threshold. */
  breached: boolean
}

/**
 * Bounce rate per mailbox over the rolling window (never reaching back before a
 * mailbox's `healthResetAt`).
 *
 * A bounce is either an SMTP hard bounce the scheduler recorded against the
 * mailbox (messages 'failed' with failedAt and connectionId set, dated by
 * failedAt) or a bounce notice (DSN) stored in that mailbox's IMAP inbox.
 *
 * Inbox notices carry no lead link, so they are counted per notice, minus
 * mirrored duplicates and delay notices ("Delivery Status Notification
 * (Delay)" and similar, which the poller also flags as bounces). Delay
 * detection is best effort: only the subject and the plain-text body are stored.
 */
export async function computeMailboxHealth(
  opts: { connectionId?: number; settings?: HealthSettings; now?: Date } = {},
): Promise<MailboxHealth[]> {
  const settings = opts.settings ?? (await getHealthSettings())
  const now = opts.now ?? new Date()
  const windowStart = new Date(now.getTime() - settings.windowDays * DAY_MS)
  const windowStartSec = Math.floor(windowStart.getTime() / 1000)

  const rows = await db
    .select({
      id: connections.id,
      label: connections.label,
      fromEmail: connections.fromEmail,
      status: connections.status,
      consecutiveFailures: connections.consecutiveFailures,
      lastError: connections.lastError,
      dnsRecords: connections.dnsRecords,
      imapEnabled: connections.imapEnabled,
      healthResetAt: connections.healthResetAt,
      healthPausedAt: connections.healthPausedAt,
    })
    .from(connections)
    .where(opts.connectionId !== undefined ? eq(connections.id, opts.connectionId) : undefined)
    .orderBy(connections.createdAt)
  if (rows.length === 0) return []

  // Campaign sends only (stepPosition 0 is a manual inbox reply).
  const sentRows = await db
    .select({ connectionId: messages.connectionId, count: sql<number>`count(*)` })
    .from(messages)
    .innerJoin(connections, eq(messages.connectionId, connections.id))
    .where(
      and(
        gt(messages.stepPosition, 0),
        eq(messages.status, 'sent'),
        gte(messages.sentAt, windowStart),
        sql`${messages.sentAt} >= coalesce(${connections.healthResetAt}, 0)`,
        opts.connectionId !== undefined ? eq(messages.connectionId, opts.connectionId) : undefined,
      ),
    )
    .groupBy(messages.connectionId)

  const smtpBounceRows = await db
    .select({ connectionId: messages.connectionId, count: sql<number>`count(*)` })
    .from(messages)
    .innerJoin(connections, eq(messages.connectionId, connections.id))
    .where(
      and(
        gt(messages.stepPosition, 0),
        eq(messages.status, 'failed'),
        gte(messages.failedAt, windowStart),
        sql`${messages.failedAt} >= coalesce(${connections.healthResetAt}, 0)`,
        opts.connectionId !== undefined ? eq(messages.connectionId, opts.connectionId) : undefined,
      ),
    )
    .groupBy(messages.connectionId)

  const receivedAt = sql`coalesce(${inboundEmails.receivedAt}, ${inboundEmails.createdAt})`
  const isDelayNotice = sql`(
    (lower(${inboundEmails.subject}) like '%delay%' and lower(${inboundEmails.subject}) not like '%undeliverable%')
    or lower(coalesce(${inboundEmails.bodyText}, '')) like '%action: delayed%'
    or lower(coalesce(${inboundEmails.bodyText}, '')) like '%delivery incomplete%'
  )`
  const inboxBounceRows = await db
    .select({ connectionId: inboundEmails.connectionId, count: sql<number>`count(*)` })
    .from(inboundEmails)
    .innerJoin(connections, eq(inboundEmails.connectionId, connections.id))
    .where(
      and(
        eq(inboundEmails.isBounce, true),
        eq(inboundEmails.isDuplicate, false),
        isNotNull(inboundEmails.connectionId),
        sql`not ${isDelayNotice}`,
        sql`${receivedAt} >= ${windowStartSec}`,
        sql`${receivedAt} >= coalesce(${connections.healthResetAt}, 0)`,
        opts.connectionId !== undefined ? eq(inboundEmails.connectionId, opts.connectionId) : undefined,
      ),
    )
    .groupBy(inboundEmails.connectionId)

  const toMap = (list: { connectionId: number | null; count: number }[]) =>
    new Map(list.map((r) => [r.connectionId, Number(r.count)]))
  const sentOk = toMap(sentRows)
  const smtpBounced = toMap(smtpBounceRows)
  const inboxBounced = toMap(inboxBounceRows)

  return rows.map((c) => {
    const autoPaused = c.status === 'paused' && c.healthPausedAt != null
    const smtpBounces = smtpBounced.get(c.id) ?? 0
    const inboxBounces = inboxBounced.get(c.id) ?? 0
    const sent = (sentOk.get(c.id) ?? 0) + smtpBounces
    const bounces = smtpBounces + inboxBounces
    const rate = Math.min(100, (bounces / Math.max(sent, 1)) * 100)
    const since = new Date(Math.max(windowStart.getTime(), c.healthResetAt?.getTime() ?? 0))

    return {
      connectionId: c.id,
      label: c.label,
      fromEmail: c.fromEmail,
      status: c.status,
      resetAt: c.healthResetAt?.toISOString() ?? null,
      since: since.toISOString(),
      windowDays: settings.windowDays,
      sent,
      bounces,
      smtpBounces,
      inboxBounces,
      bounceRate: Math.round(rate * 10) / 10,
      imapEnabled: c.imapEnabled,
      consecutiveFailures: c.consecutiveFailures,
      lastError: c.lastError,
      dns: c.dnsRecords
        ? { spf: c.dnsRecords.spf, dkim: c.dnsRecords.dkim, dmarc: c.dnsRecords.dmarc }
        : null,
      autoPaused,
      pausedAt: autoPaused ? c.healthPausedAt!.toISOString() : null,
      pauseReason: autoPaused && c.lastError?.startsWith(HEALTH_ERROR_PREFIX) ? c.lastError : null,
      breached: sent >= settings.minSends && rate >= settings.bounceThreshold,
    }
  })
}

export type HealthCheckResult = {
  autoPause: boolean
  /** Active mailboxes that were evaluated. */
  checked: number
  paused: {
    connectionId: number
    label: string
    fromEmail: string
    bounceRate: number
    bounces: number
    sent: number
    pausedAt: string
  }[]
}

/**
 * Pause every active mailbox whose bounce rate is at or above the threshold.
 * Only touches the mailbox's status and lastError; paused and errored mailboxes
 * are skipped, and nothing is deleted.
 */
export async function runHealthCheck(now = new Date()): Promise<HealthCheckResult> {
  const settings = await getHealthSettings()
  const health = (await computeMailboxHealth({ settings, now })).filter((h) => h.status === 'active')
  const result: HealthCheckResult = { autoPause: settings.autoPause, checked: health.length, paused: [] }
  if (!settings.autoPause) return result

  // Stored timestamps have second precision; report the same value back.
  const pausedAt = new Date(Math.floor(now.getTime() / 1000) * 1000)

  for (const h of health) {
    if (!h.breached) continue

    // Only flip a mailbox that is still active AND whose bounce history has not
    // been reset since the numbers above were read (null-safe compare), so a
    // resume or a user edit in between is never overwritten with stale numbers.
    const resetAtSec = h.resetAt ? Math.floor(new Date(h.resetAt).getTime() / 1000) : null
    const updated = await db
      .update(connections)
      .set({
        status: 'paused',
        healthPausedAt: pausedAt,
        lastError: `${HEALTH_ERROR_PREFIX} bounce rate ${h.bounceRate}% (${h.bounces} of ${h.sent}) over ${settings.windowDays} days, auto-paused`,
      })
      .where(
        and(
          eq(connections.id, h.connectionId),
          eq(connections.status, 'active'),
          sql`${connections.healthResetAt} is ${resetAtSec}`,
        ),
      )
      .returning({ id: connections.id })
    if (updated.length === 0) continue

    result.paused.push({
      connectionId: h.connectionId,
      label: h.label,
      fromEmail: h.fromEmail,
      bounceRate: h.bounceRate,
      bounces: h.bounces,
      sent: h.sent,
      pausedAt: pausedAt.toISOString(),
    })
    console.log(
      `[Lightreach] Health: paused connection ${h.connectionId} (${h.fromEmail}), bounce rate ${h.bounceRate}% (${h.bounces} of ${h.sent}) over ${settings.windowDays} days`,
    )
  }
  return result
}

let monitorHandle: ReturnType<typeof setInterval> | null = null
let checking = false

async function tick(): Promise<void> {
  // A check is a handful of cheap queries, but guard anyway so ticks never overlap.
  if (checking) return
  checking = true
  try {
    await runHealthCheck()
  } finally {
    checking = false
  }
}

export function startHealthMonitor(): void {
  if (monitorHandle) {
    console.log('[Lightreach] Health monitor already running.')
    return
  }

  console.log('[Lightreach] Health monitor started. Tick interval:', TICK_MS, 'ms')

  monitorHandle = setInterval(() => {
    tick().catch((err) => {
      console.error('[Lightreach] Health monitor tick error:', err)
    })
  }, TICK_MS)

  tick().catch((err) => {
    console.error('[Lightreach] Health monitor startup error:', err)
  })

  monitorHandle.unref()
}

export function stopHealthMonitor(): void {
  if (monitorHandle) {
    clearInterval(monitorHandle)
    monitorHandle = null
    console.log('[Lightreach] Health monitor stopped.')
  }
}
