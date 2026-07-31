# Server Actions in `apps/web`

> Code examples: `app/(dashboard)/connections/actions.ts`,
> `app/(dashboard)/settings/actions.ts`, and `app/(dashboard)/leads/actions.ts`.

---

## File shape

Write one `actions.ts` for each feature directory. Put `'use server'` on the
first line of the file. Never put it on a single function. The imports follow it.

```ts
// app/(dashboard)/leads/actions.ts
'use server'
import { db, lists, leads } from '@workspace/db'
import { eq, and, not } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import type { MappedLead } from '@workspace/core/csv'
```

CAUTION: Every exported function in this file is a network endpoint. A client can
call it. If a client must not reach a helper, do not export that helper.
`runDnsCheck` at `connections/actions.ts:17` is module-private for this reason.

## Return type

**Dominant pattern: return a result object.** If an action can fail in a way that
the user interface must render, return the failure. Do not throw it.

```ts
// connections/actions.ts:129
export async function testConnection(id: number): Promise<{ ok: boolean; error?: string }> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id))
  if (!row) return { ok: false, error: 'Connection not found' }
  // ...
}
```

Use this pattern for a new action. Write the return type in full. Make the error
a string that the user interface can render.

**Legacy pattern: `throw new Error`. It is present. Do not propagate it.**

```ts
// leads/actions.ts:68  DO NOT COPY THIS
if (existing.length > 0) throw new Error('A lead with this email already exists in the list')
// leads/actions.ts:100  same
// settings/actions.ts   same, on the validation guard
```

The Leads CSV work edits `leads/actions.ts`. The legacy pattern is therefore in
the file that you open. If you add an action to that file, use the result-object
form. The neighbouring functions keep the legacy form.

Do not convert the existing functions as part of another change. The `catch`
blocks in `leads-view.tsx` depend on the current behaviour. That conversion is a
separate change with client callers to update.

An action that cannot fail returns `void` or the new id. This stays correct:

```ts
export async function deleteLead(id: number) { /* ... */ }
export async function createList(name: string): Promise<number> { /* ... */ }
export async function importLeads(listId: number, rows: MappedLead[]):
  Promise<{ inserted: number; skipped: number }>
```

## End every mutation with `revalidatePath`

The last statement before the return revalidates the route of the feature:

```ts
await db.delete(leads).where(eq(leads.id, id))
revalidatePath('/leads')
```

`updateLead` gives the conditional form. If nothing changed, it revalidates
nothing:

```ts
if (Object.keys(patch).length > 0) {
  await db.update(leads).set(patch).where(eq(leads.id, id))
  revalidatePath('/leads')
}
```

## Validate and normalize in the action

The action is the trust boundary. Do not trust the client. Make sure that the
shape and the size are correct, then normalize the value.

```ts
// settings/actions.ts
const MAX_FOOTER_LENGTH = 2000
if (typeof text !== 'string' || text.length > MAX_FOOTER_LENGTH) {
  throw new Error('Invalid opt-out footer')
}
const value = text.trim() ? text : DEFAULT_UNSUBSCRIBE_TEXT
```

These normalization rules apply to leads. See `leads/actions.ts:56`.

- Store each email address as `.toLowerCase().trim()`.
- Apply `.trim()` to each optional text field, with `?? ''`. Never store
  `undefined`. The columns are `notNull().default("")`. See the schema spec.

CAUTION: `importLeads` is the exception. It inserts `MappedLead` rows directly
from `@workspace/core/csv` and applies no `.trim()`, because `parseCSV` already
applies `transform: (v) => v.trim()`. It lowercases the email address for the
comparison only. It stores the original text. Lead email addresses in the
database are therefore not always lowercase.

## Write bulk inserts as one statement

`importLeads` loads the existing email addresses of the list, filters the new
rows, then runs one insert with many rows. It does not loop.

```ts
const existingEmails = new Set(existing.map((r) => r.email.toLowerCase()))
const fresh = rows.filter((r) => !existingEmails.has(r.email.toLowerCase()))
if (fresh.length > 0) {
  await db.insert(leads).values(fresh.map((r) => ({ listId, ...r })))
}
return { inserted: fresh.length, skipped: rows.length - fresh.length }
```

Two limits apply to this code. First, the filter uses `listId`, so the same email
address can exist in two lists. Second, the code reads and then writes with no
transaction. Two concurrent imports of one file can both insert the same rows.
The `leads.email` column has no unique index to stop this.

## Write upserts with `onConflictDoUpdate`

```ts
// settings/actions.ts
await db
  .insert(appSettings)
  .values({ key: 'unsubscribe_footer', value })
  .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } })
```

## Narrow every indexed read

`noUncheckedIndexedAccess` is on. A destructured query result can be `undefined`.
Both forms appear in the code:

```ts
const [row] = await db.select()...        // row: T | undefined
if (!row) return { ok: false, error: 'Connection not found' }   // preferred
return row!.id                                                   // used in createList
```

In new code, write the guard. Do not write `!`.

## Document effects that other subsystems read

If another subsystem reads the result of an action, say so in the doc comment:

```ts
/**
 * Persist the opt-out footer appended to every outbound campaign email.
 * The scheduler reads this on its next tick (key: 'unsubscribe_footer').
 */
```

That sentence is the only link between this action and `lib/scheduler.ts`.
Continue to write these comments.
