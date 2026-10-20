import { db, suppressions } from '@workspace/db'
import { desc } from 'drizzle-orm'
import { SuppressionsView } from './suppressions-view'

export default async function SuppressionsPage() {
  const rows = await db.select().from(suppressions).orderBy(desc(suppressions.createdAt), desc(suppressions.id))

  return (
    <SuppressionsView
      entries={rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        value: r.value,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      }))}
    />
  )
}
