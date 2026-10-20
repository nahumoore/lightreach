'use server'
import { db, connections } from '@workspace/db'
import type { Connection } from '@workspace/db'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { encrypt, decrypt } from '@workspace/core/crypto'
import { verifyConnection, sendMail } from '@workspace/core/email/transport'
import { checkDomainAuth, domainFromEmail } from '@workspace/core/email/dns'
import { resolveImapConfig, verifyImap } from '@workspace/core/email/imap'

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

function resolvedImapFields(
  data: Pick<
    ConnectionInput,
    'imapEnabled' | 'imapSameAsSmtp' | 'imapHost' | 'imapPort' | 'imapSecure' | 'imapUser'
  >,
) {
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

/**
 * Partial update: only the fields present in `data` change. Passwords are only
 * re-encrypted when a non-empty value is passed. The IMAP columns are only
 * touched when at least one IMAP field is passed.
 */
export async function updateConnection(id: number, data: Partial<ConnectionInput>) {
  const [row] = await db.select().from(connections).where(eq(connections.id, id))
  if (!row) throw new Error('Connection not found')

  const patch: Record<string, unknown> = {}
  if (data.label !== undefined) patch.label = data.label
  if (data.fromName !== undefined) patch.fromName = data.fromName
  if (data.fromEmail !== undefined) patch.fromEmail = data.fromEmail
  if (data.smtpHost !== undefined) patch.smtpHost = data.smtpHost
  if (data.smtpPort !== undefined) patch.smtpPort = data.smtpPort
  if (data.smtpSecure !== undefined) patch.smtpSecure = data.smtpSecure
  if (data.smtpUser !== undefined) patch.smtpUser = data.smtpUser
  if (data.dailyLimit !== undefined) patch.dailyLimit = data.dailyLimit
  if (data.smtpPass?.trim()) {
    patch.smtpPassEncrypted = encrypt(data.smtpPass)
  }

  const touchesImap = [
    data.imapEnabled,
    data.imapSameAsSmtp,
    data.imapHost,
    data.imapPort,
    data.imapSecure,
    data.imapUser,
    data.imapPass,
  ].some((v) => v !== undefined)

  if (touchesImap) {
    const imapPass = data.imapPass ?? ''
    const merged = {
      imapEnabled: data.imapEnabled ?? row.imapEnabled,
      imapSameAsSmtp: data.imapSameAsSmtp ?? row.imapSameAsSmtp,
      imapHost: data.imapHost ?? row.imapHost ?? '',
      imapPort: data.imapPort ?? row.imapPort ?? 993,
      imapSecure: data.imapSecure ?? row.imapSecure ?? true,
      imapUser: data.imapUser ?? row.imapUser ?? '',
    }
    Object.assign(patch, resolvedImapFields(merged))
    if (merged.imapEnabled && !merged.imapSameAsSmtp) {
      if (imapPass.trim()) patch.imapPassEncrypted = encrypt(imapPass)
    } else {
      patch.imapPassEncrypted = null
    }
  }

  if (Object.keys(patch).length > 0) {
    await db.update(connections).set(patch).where(eq(connections.id, id))
    revalidatePath('/connections')
  }
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

export type CheckResult = { ok: boolean; error?: string }

export type TestConnectionResult = {
  ok: boolean
  error?: string
  smtp?: CheckResult
  /** null when IMAP is not enabled for this mailbox */
  imap?: CheckResult | null
}

const IMAP_TEST_TIMEOUT_MS = 20_000

/** Verify the mailbox's IMAP login. Returns null when IMAP is disabled. Never throws. */
async function runImapCheck(row: Connection): Promise<CheckResult | null> {
  if (!row.imapEnabled) return null
  try {
    const config = resolveImapConfig(row, decrypt)
    if (!config) return { ok: false, error: 'IMAP is enabled but host, user or password is missing' }
    // verifyImap has no timeout of its own; bound it so a black-holed host
    // can't hang the test longer than the SMTP check does.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<CheckResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: `timed out after ${IMAP_TEST_TIMEOUT_MS / 1000}s` }),
        IMAP_TEST_TIMEOUT_MS,
      )
    })
    try {
      return await Promise.race([verifyImap(config), timeout])
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function testConnection(id: number): Promise<TestConnectionResult> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id))
  if (!row) return { ok: false, error: 'Connection not found' }

  const smtpPass = decrypt(row.smtpPassEncrypted)
  const [smtp, imap, dnsRecords] = await Promise.all([
    verifyConnection({
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      smtpSecure: row.smtpSecure,
      smtpUser: row.smtpUser,
      smtpPass,
    }),
    runImapCheck(row),
    runDnsCheck(row.fromEmail),
  ])

  // SMTP decides the mailbox status (it is what sending needs). An IMAP failure
  // only surfaces in lastError, matching the "IMAP: ..." prefix the poller uses.
  const lastError = smtp.ok ? (imap && !imap.ok ? `IMAP: ${imap.error}` : null) : smtp.error
  await db
    .update(connections)
    .set({
      lastTestedAt: new Date(),
      lastError,
      status: smtp.ok ? 'active' : 'error',
      dnsRecords,
    })
    .where(eq(connections.id, id))

  revalidatePath('/connections')

  const smtpResult: CheckResult = smtp.ok ? { ok: true } : { ok: false, error: smtp.error }
  const errors = [
    smtpResult.ok ? null : `SMTP: ${smtpResult.error}`,
    !imap || imap.ok ? null : `IMAP: ${imap.error}`,
  ].filter(Boolean)
  return {
    ok: errors.length === 0,
    ...(errors.length > 0 && { error: errors.join('; ') }),
    smtp: smtpResult,
    imap,
  }
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
