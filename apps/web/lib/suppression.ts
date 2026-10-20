import { db, suppressions } from '@workspace/db'
import { and, eq, or } from 'drizzle-orm'
import { encrypt, decrypt } from '@workspace/core/crypto'
import { parseCSV } from '@workspace/core/csv'

export type SuppressionKind = 'email' | 'domain'
export type SuppressionReason = 'unsubscribed' | 'bounced' | 'stop_reply' | 'manual' | 'import'
export type ParsedSuppression = { kind: SuppressionKind; value: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// At least one dot, no empty labels, no whitespace or "@".
const DOMAIN_RE = /^[^\s@.]+(\.[^\s@.]+)+$/

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Domains are stored lowercased and without the leading "@". */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '')
}

function normalizeValue(kind: SuppressionKind, value: string): string {
  return kind === 'email' ? normalizeEmail(value) : normalizeDomain(value)
}

/**
 * Turn free-form input into a suppression entry. "jane@acme.com" is an email;
 * "@acme.com" and "acme.com" are both the domain. Returns null for anything else.
 * Plus-addresses are kept as written: jane+a@acme.com and jane@acme.com are distinct.
 */
export function parseSuppressionValue(raw: string): ParsedSuppression | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null

  if (trimmed.startsWith('@') || !trimmed.includes('@')) {
    const domain = normalizeDomain(trimmed)
    return DOMAIN_RE.test(domain) ? { kind: 'domain', value: domain } : null
  }
  return EMAIL_RE.test(trimmed) ? { kind: 'email', value: trimmed } : null
}

const CSV_VALUE_COLUMN_RE = /^(e-?mail( address)?|address|domain|value)$/i

/**
 * Pull the addresses/domains out of a CSV. Uses the column named email, address,
 * domain or value, else the first column. A file with no header row (its first
 * line is already an address or domain) is accepted too.
 */
export function suppressionValuesFromCsv(csv: string): string[] {
  const { headers, rows } = parseCSV(csv)
  const first = headers[0]
  if (first === undefined) return []

  const column = headers.find((h) => CSV_VALUE_COLUMN_RE.test(h))
  if (column) return rows.map((row) => row[column] ?? '')

  const values = rows.map((row) => row[first] ?? '')
  return parseSuppressionValue(first) ? [first, ...values] : values
}

/** Every suppression entry that covers this address: the address itself and/or its domain. */
export async function findSuppressions(email: string) {
  const address = normalizeEmail(email)
  const domain = address.split('@')[1]

  return db
    .select()
    .from(suppressions)
    .where(
      or(
        and(eq(suppressions.kind, 'email'), eq(suppressions.value, address)),
        domain ? and(eq(suppressions.kind, 'domain'), eq(suppressions.value, domain)) : undefined,
      ),
    )
}

/** True if the address, or its whole domain, is on the suppression list. */
export async function isSuppressed(email: string): Promise<boolean> {
  return (await findSuppressions(email)).length > 0
}

/** Add an entry. Returns false if it was already on the list (the existing entry is left untouched). */
export async function suppress(entry: {
  kind: SuppressionKind
  value: string
  reason: SuppressionReason
  leadId?: number | null
  messageId?: number | null
}): Promise<boolean> {
  const result = await db
    .insert(suppressions)
    .values({
      kind: entry.kind,
      value: normalizeValue(entry.kind, entry.value),
      reason: entry.reason,
      leadId: entry.leadId ?? null,
      messageId: entry.messageId ?? null,
    })
    .onConflictDoNothing()
  return result.changes > 0
}

// ---------------------------------------------------------------------------
// Unsubscribe links
// ---------------------------------------------------------------------------

/**
 * Opaque, tamper-proof token for the unsubscribe link: the AES-256-GCM
 * encrypted {email, messageRowId}. It carries everything the route needs, so
 * links keep working after the campaign (and its message rows) are deleted.
 * Changing APP_ENCRYPTION_KEY invalidates every link already sent.
 */
export function createUnsubscribeToken(email: string, messageRowId: number): string {
  return encrypt(JSON.stringify({ email: normalizeEmail(email), messageRowId }))
}

export function verifyUnsubscribeToken(token: string): { email: string; messageRowId: number } | null {
  try {
    const data: unknown = JSON.parse(decrypt(token))
    if (typeof data !== 'object' || data === null) return null
    const { email, messageRowId } = data as { email?: unknown; messageRowId?: unknown }
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) return null
    if (typeof messageRowId !== 'number' || !Number.isInteger(messageRowId)) return null
    return { email: normalizeEmail(email), messageRowId }
  } catch {
    // Wrong key, truncated or hand-edited token.
    return null
  }
}

/** Public base URL of this app from APP_URL, without a trailing slash. Null if unset or not an http(s) URL. */
export function getAppUrl(): string | null {
  const raw = process.env['APP_URL']?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return raw.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * List-Unsubscribe headers for a campaign email. The body footer stays the
 * plain "reply STOP" line; these headers are what mail clients use for their
 * own Unsubscribe button.
 *
 * - APP_URL set: an https/http link plus a mailto fallback. One-click
 *   (RFC 8058) is only advertised when APP_URL is https, as the RFC requires.
 * - APP_URL unset: mailto only. The mailto goes to the sending mailbox with
 *   subject "unsubscribe", which the inbox poller treats like a STOP reply.
 */
export function buildUnsubscribeHeaders(opts: {
  email: string
  messageRowId: number
  mailbox: string
}): Record<string, string> {
  const mailto = `<mailto:${opts.mailbox}?subject=unsubscribe>`
  const baseUrl = getAppUrl()
  if (!baseUrl) return { 'List-Unsubscribe': mailto }

  const link = `<${baseUrl}/api/unsubscribe/${createUnsubscribeToken(opts.email, opts.messageRowId)}>`
  const headers: Record<string, string> = { 'List-Unsubscribe': `${link}, ${mailto}` }
  if (baseUrl.startsWith('https://')) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  }
  return headers
}
