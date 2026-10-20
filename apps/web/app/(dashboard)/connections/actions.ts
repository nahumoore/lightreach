'use server'
import { db, connections } from '@workspace/db'
import { and, eq, isNull, ne, or } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { encrypt, decrypt } from '@workspace/core/crypto'
import { verifyConnection, sendMail } from '@workspace/core/email/transport'
import { checkDomainAuth, domainFromEmail } from '@workspace/core/email/dns'
import { healthResetPatch } from '@/lib/health'

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
  const [row] = await db
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, id))
  if (!row) return

  const newStatus = currentStatus === 'active' ? 'paused' : 'active'
  // Resuming a paused mailbox starts its bounce history fresh, so the bounces
  // that got it auto-paused don't pause it again on the next health check. The
  // stored status decides this, not the caller's currentStatus.
  const resuming = row.status === 'paused' && newStatus === 'active'
  await db
    .update(connections)
    .set({ status: newStatus, ...(resuming ? healthResetPatch() : {}) })
    .where(eq(connections.id, id))
  revalidatePath('/connections')
}

export async function testConnection(
  id: number,
): Promise<{ ok: boolean; error?: string; autoPaused?: boolean }> {
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

  const autoPaused = row.status === 'paused' && row.healthPausedAt !== null
  // Never undo an auto-pause that lands while the test is running.
  const notAutoPaused = or(ne(connections.status, 'paused'), isNull(connections.healthPausedAt))

  if (autoPaused) {
    // Auto-paused by the health check: a test only records its own result. The
    // mailbox stays paused until it is resumed explicitly.
    await db
      .update(connections)
      .set({ lastTestedAt: new Date(), dnsRecords })
      .where(eq(connections.id, id))
  } else if (result.ok) {
    await db
      .update(connections)
      .set({
        lastTestedAt: new Date(),
        lastError: null,
        status: 'active',
        healthPausedAt: null,
        dnsRecords,
        // A passing test re-activates a user-paused mailbox, same as resuming it by hand.
        ...(row.status === 'paused' ? { healthResetAt: new Date() } : {}),
      })
      .where(and(eq(connections.id, id), notAutoPaused))
  } else {
    await db
      .update(connections)
      .set({
        lastTestedAt: new Date(),
        lastError: result.error,
        status: 'error',
        healthPausedAt: null,
        dnsRecords,
      })
      .where(and(eq(connections.id, id), notAutoPaused))
  }

  revalidatePath('/connections')
  if (!result.ok) return { ok: false, error: result.error }
  return autoPaused ? { ok: true, autoPaused: true } : { ok: true }
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
