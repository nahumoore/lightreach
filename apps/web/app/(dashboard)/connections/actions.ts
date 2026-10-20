'use server'
import { db, connections } from '@workspace/db'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { encrypt, decrypt } from '@workspace/core/crypto'
import { verifyConnection, sendMail } from '@workspace/core/email/transport'
import { checkDomainAuth, domainFromEmail } from '@workspace/core/email/dns'
import { runWarmupNow } from '@/lib/warmup'

type DnsRecords = {
  spf: boolean
  dkim: boolean
  dmarc: boolean
  valid: boolean
  checkedAt: string
}

/** Run the SPF/DKIM/DMARC check for a mailbox's from-email domain. Never throws. */
async function runDnsCheck(fromEmail: string): Promise<DnsRecords> {
  const domain = domainFromEmail(fromEmail)
  if (!domain) {
    return { spf: false, dkim: false, dmarc: false, valid: false, checkedAt: new Date().toISOString() }
  }
  try {
    return await checkDomainAuth(domain)
  } catch {
    return { spf: false, dkim: false, dmarc: false, valid: false, checkedAt: new Date().toISOString() }
  }
}

type ConnectionInput = {
  label: string
  fromName: string
  fromEmail: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPass: string
  dailyLimit: number
  imapEnabled: boolean
  imapSameAsSmtp: boolean
  imapHost: string
  imapPort: number
  imapSecure: boolean
  imapUser: string
  imapPass: string
}

function resolvedImapFields(data: ConnectionInput) {
  if (!data.imapEnabled || data.imapSameAsSmtp) {
    return {
      imapEnabled: data.imapEnabled,
      imapSameAsSmtp: data.imapSameAsSmtp,
      imapHost: null as string | null,
      imapPort: null as number | null,
      imapSecure: null as boolean | null,
      imapUser: null as string | null,
    }
  }
  return {
    imapEnabled: true as boolean,
    imapSameAsSmtp: false as boolean,
    imapHost: data.imapHost || null,
    imapPort: data.imapPort,
    imapSecure: data.imapSecure,
    imapUser: data.imapUser || null,
  }
}

export async function createConnection(data: ConnectionInput) {
  const { smtpPass, imapPass, ...rest } = data
  const imap = resolvedImapFields(data)
  const dnsRecords = await runDnsCheck(rest.fromEmail)
  await db.insert(connections).values({
    label: rest.label,
    fromName: rest.fromName,
    fromEmail: rest.fromEmail,
    smtpHost: rest.smtpHost,
    smtpPort: rest.smtpPort,
    smtpSecure: rest.smtpSecure,
    smtpUser: rest.smtpUser,
    dailyLimit: rest.dailyLimit,
    smtpPassEncrypted: encrypt(smtpPass),
    dnsRecords,
    ...imap,
    imapPassEncrypted:
      data.imapEnabled && !data.imapSameAsSmtp && imapPass ? encrypt(imapPass) : null,
  })
  revalidatePath('/connections')
}

export async function updateConnection(id: number, data: ConnectionInput) {
  const { smtpPass, imapPass, ...rest } = data
  const imap = resolvedImapFields(data)
  const patch: Record<string, unknown> = {
    label: rest.label,
    fromName: rest.fromName,
    fromEmail: rest.fromEmail,
    smtpHost: rest.smtpHost,
    smtpPort: rest.smtpPort,
    smtpSecure: rest.smtpSecure,
    smtpUser: rest.smtpUser,
    dailyLimit: rest.dailyLimit,
    ...imap,
  }
  if (smtpPass.trim()) {
    patch.smtpPassEncrypted = encrypt(smtpPass)
  }
  if (data.imapEnabled && !data.imapSameAsSmtp) {
    if (imapPass.trim()) patch.imapPassEncrypted = encrypt(imapPass)
  } else {
    patch.imapPassEncrypted = null
  }
  await db.update(connections).set(patch).where(eq(connections.id, id))
  revalidatePath('/connections')
}

export async function deleteConnection(id: number) {
  await db.delete(connections).where(eq(connections.id, id))
  revalidatePath('/connections')
}

export async function toggleConnectionStatus(id: number, currentStatus: string) {
  const newStatus = currentStatus === 'active' ? 'paused' : 'active'
  await db.update(connections).set({ status: newStatus }).where(eq(connections.id, id))
  revalidatePath('/connections')
}

export async function testConnection(id: number): Promise<{ ok: boolean; error?: string }> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id))
  if (!row) return { ok: false, error: 'Connection not found' }

  const smtpPass = decrypt(row.smtpPassEncrypted)
  const [result, dnsRecords] = await Promise.all([
    verifyConnection({
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      smtpSecure: row.smtpSecure,
      smtpUser: row.smtpUser,
      smtpPass,
    }),
    runDnsCheck(row.fromEmail),
  ])

  if (result.ok) {
    await db
      .update(connections)
      .set({ lastTestedAt: new Date(), lastError: null, status: 'active', dnsRecords })
      .where(eq(connections.id, id))
  } else {
    await db
      .update(connections)
      .set({ lastTestedAt: new Date(), lastError: result.error, status: 'error', dnsRecords })
      .where(eq(connections.id, id))
  }

  revalidatePath('/connections')
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function sendTestEmail(
  connectionId: number,
  to: string,
  subject?: string,
  body?: string,
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  const [row] = await db.select().from(connections).where(eq(connections.id, connectionId))
  if (!row) return { ok: false, error: 'Connection not found' }

  let smtpPass: string
  try {
    smtpPass = decrypt(row.smtpPassEncrypted)
  } catch {
    return { ok: false, error: 'Failed to decrypt mailbox credentials' }
  }

  try {
    const result = await sendMail(
      {
        smtpHost: row.smtpHost,
        smtpPort: row.smtpPort,
        smtpSecure: row.smtpSecure,
        smtpUser: row.smtpUser,
        smtpPass,
      },
      {
        fromName: row.fromName,
        fromEmail: row.fromEmail,
        to,
        subject: subject ?? 'Test email from Lightreach',
        html: (body ?? 'This is a test email sent via Lightreach.').replace(/\n/g, '<br>'),
        text: body ?? 'This is a test email sent via Lightreach.',
      },
    )
    return { ok: true, messageId: result.messageId }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function testConnectionDraft(data: {
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPass: string
}): Promise<{ ok: boolean; error?: string }> {
  return verifyConnection(data)
}

export type WarmupSettingsInput = {
  enabled?: boolean
  startVolume?: number
  dailyIncrease?: number
  maxVolume?: number
  replyRate?: number
}

function checkWarmupNumber(name: string, value: number | undefined, min: number, max: number) {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}`)
  }
}

/** Partial update of a mailbox's warmup settings. Switching warmup on restarts the ramp. */
export async function updateWarmupSettings(id: number, data: WarmupSettingsInput) {
  checkWarmupNumber('Start volume', data.startVolume, 1, 500)
  checkWarmupNumber('Daily increase', data.dailyIncrease, 0, 500)
  checkWarmupNumber('Max volume', data.maxVolume, 1, 500)
  checkWarmupNumber('Reply rate', data.replyRate, 0, 100)

  const [row] = await db
    .select({ warmupEnabled: connections.warmupEnabled })
    .from(connections)
    .where(eq(connections.id, id))
  if (!row) throw new Error('Connection not found')

  const patch: Partial<typeof connections.$inferInsert> = {}
  if (data.enabled !== undefined) {
    patch.warmupEnabled = data.enabled
    if (data.enabled && !row.warmupEnabled) patch.warmupStartedAt = new Date()
  }
  if (data.startVolume !== undefined) patch.warmupStartVolume = data.startVolume
  if (data.dailyIncrease !== undefined) patch.warmupDailyIncrease = data.dailyIncrease
  if (data.maxVolume !== undefined) patch.warmupMaxVolume = data.maxVolume
  if (data.replyRate !== undefined) patch.warmupReplyRate = data.replyRate

  if (Object.keys(patch).length > 0) {
    await db.update(connections).set(patch).where(eq(connections.id, id))
  }
  revalidatePath('/connections')
}

/** Run one warmup pass now (no pacing; still capped by each mailbox's daily target). */
export async function triggerWarmup(): Promise<{
  ok: boolean
  error?: string
  sent?: number
  replied?: number
  found?: number
}> {
  try {
    const result = await runWarmupNow()
    revalidatePath('/connections')
    if (!result) return { ok: false, error: 'A warmup run is already in progress' }
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
