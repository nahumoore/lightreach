'use server'
import { db, suppressions } from '@workspace/db'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import {
  parseSuppressionValue,
  suppress,
  suppressionValuesFromCsv,
  type ParsedSuppression,
} from '@/lib/suppression'

const IMPORT_CHUNK_SIZE = 500

export type ImportResult = { inserted: number; duplicate: number; invalid: number }

/** Add one email (jane@acme.com) or a whole domain (@acme.com or acme.com). */
export async function addSuppression(raw: string): Promise<ParsedSuppression> {
  const parsed = parseSuppressionValue(raw)
  if (!parsed) throw new Error('Enter an email address or a domain such as @example.com')

  const added = await suppress({ ...parsed, reason: 'manual' })
  if (!added) throw new Error(`${parsed.value} is already on the suppression list`)

  revalidatePath('/suppressions')
  return parsed
}

/**
 * Removing an entry only lifts the block on future sends. A lead that was
 * marked bounced or unsubscribed keeps that status until you change it.
 */
export async function removeSuppression(id: number) {
  await db.delete(suppressions).where(eq(suppressions.id, id))
  revalidatePath('/suppressions')
}

export async function importSuppressions(values: string[]): Promise<ImportResult> {
  const entries = new Map<string, ParsedSuppression>()
  let invalid = 0
  let repeated = 0

  for (const raw of values) {
    if (!raw.trim()) continue
    const parsed = parseSuppressionValue(raw)
    if (!parsed) {
      invalid++
    } else if (entries.has(`${parsed.kind}:${parsed.value}`)) {
      repeated++
    } else {
      entries.set(`${parsed.kind}:${parsed.value}`, parsed)
    }
  }

  const rows = [...entries.values()].map((e) => ({ ...e, reason: 'import' }))
  let inserted = 0
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
    const result = await db
      .insert(suppressions)
      .values(rows.slice(i, i + IMPORT_CHUNK_SIZE))
      .onConflictDoNothing()
    inserted += result.changes
  }

  revalidatePath('/suppressions')
  return { inserted, duplicate: repeated + rows.length - inserted, invalid }
}

export async function importSuppressionsCsv(csv: string): Promise<ImportResult> {
  return importSuppressions(suppressionValuesFromCsv(csv))
}
