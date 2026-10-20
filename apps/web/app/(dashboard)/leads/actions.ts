'use server'
import { db, lists, leads } from '@workspace/db'
import { eq, and, not, inArray, asc } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { MappedLead } from '@workspace/core/csv'

export async function createList(name: string): Promise<number> {
  const [row] = await db
    .insert(lists)
    .values({ name: name.trim() })
    .returning({ id: lists.id })
  revalidatePath('/leads')
  return row!.id
}

export async function renameList(id: number, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('List name cannot be empty')
  const updated = await db
    .update(lists)
    .set({ name: trimmed })
    .where(eq(lists.id, id))
    .returning({ id: lists.id })
  if (updated.length === 0) throw new Error('List not found')
  revalidatePath('/leads')
}

export async function deleteList(id: number) {
  await db.delete(lists).where(eq(lists.id, id))
  revalidatePath('/leads')
}

export async function importLeads(
  listId: number,
  rows: MappedLead[],
): Promise<{ inserted: number; skipped: number }> {
  const existing = await db
    .select({ email: leads.email })
    .from(leads)
    .where(eq(leads.listId, listId))
  const existingEmails = new Set(existing.map((r) => r.email.toLowerCase()))

  const fresh = rows.filter((r) => !existingEmails.has(r.email.toLowerCase()))

  if (fresh.length > 0) {
    await db.insert(leads).values(
      fresh.map((r) => ({
        listId,
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        company: r.company,
        openingLine: r.openingLine,
        customFields: r.customFields,
      })),
    )
  }

  revalidatePath('/leads')
  return { inserted: fresh.length, skipped: rows.length - fresh.length }
}

export async function deleteLead(id: number) {
  await db.delete(leads).where(eq(leads.id, id))
  revalidatePath('/leads')
}

export async function createLead(data: {
  listId: number
  email: string
  firstName?: string
  lastName?: string
  company?: string
  openingLine?: string
  customFields?: Record<string, string>
}): Promise<void> {
  const existing = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.email, data.email.toLowerCase().trim()))
  if (existing.length > 0) throw new Error('A lead with this email already exists in the list')

  await db.insert(leads).values({
    listId: data.listId,
    email: data.email.toLowerCase().trim(),
    firstName: data.firstName?.trim() ?? '',
    lastName: data.lastName?.trim() ?? '',
    company: data.company?.trim() ?? '',
    openingLine: data.openingLine?.trim() ?? '',
    customFields: data.customFields ?? {},
  })
  revalidatePath('/leads')
}

export async function updateLead(
  id: number,
  data: {
    email?: string
    firstName?: string
    lastName?: string
    company?: string
    openingLine?: string
    status?: string
    customFields?: Record<string, string>
  },
): Promise<void> {
  const patch: Record<string, unknown> = {}

  if (data.email !== undefined) {
    const normalized = data.email.toLowerCase().trim()
    const existing = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.email, normalized), not(eq(leads.id, id))))
    if (existing.length > 0) throw new Error('A lead with this email already exists')
    patch.email = normalized
  }
  if (data.firstName !== undefined) patch.firstName = data.firstName.trim()
  if (data.lastName !== undefined) patch.lastName = data.lastName.trim()
  if (data.company !== undefined) patch.company = data.company.trim()
  if (data.openingLine !== undefined) patch.openingLine = data.openingLine.trim()
  if (data.status !== undefined) patch.status = data.status
  if (data.customFields !== undefined) {
    // Merge into the existing fields so a partial update keeps the other keys.
    const [current] = await db
      .select({ customFields: leads.customFields })
      .from(leads)
      .where(eq(leads.id, id))
    patch.customFields = { ...(current?.customFields ?? {}), ...data.customFields }
  }

  if (Object.keys(patch).length > 0) {
    await db.update(leads).set(patch).where(eq(leads.id, id))
    revalidatePath('/leads')
  }
}

/**
 * Move leads to another list. A lead is skipped when the target list already
 * has a lead with the same email (the same per-list rule importLeads uses).
 * Campaign history stays with the lead.
 */
export async function moveLeads(
  leadIds: number[],
  targetListId: number,
): Promise<{ moved: number; skipped: number; notFound: number }> {
  const [target] = await db.select({ id: lists.id }).from(lists).where(eq(lists.id, targetListId))
  if (!target) throw new Error('Target list not found')

  const found = await db
    .select({ id: leads.id, email: leads.email, listId: leads.listId })
    .from(leads)
    .where(inArray(leads.id, leadIds))
    .orderBy(asc(leads.id))

  const existing = await db
    .select({ email: leads.email })
    .from(leads)
    .where(eq(leads.listId, targetListId))
  const taken = new Set(existing.map((r) => r.email.toLowerCase()))

  const movable: number[] = []
  for (const lead of found) {
    if (lead.listId === targetListId) continue
    const email = lead.email.toLowerCase()
    if (taken.has(email)) continue
    taken.add(email)
    movable.push(lead.id)
  }

  if (movable.length > 0) {
    await db.update(leads).set({ listId: targetListId }).where(inArray(leads.id, movable))
  }

  revalidatePath('/leads')
  return {
    moved: movable.length,
    skipped: found.length - movable.length,
    notFound: new Set(leadIds).size - found.length,
  }
}
