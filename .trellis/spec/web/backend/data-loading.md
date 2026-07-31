# Data Loading in `apps/web`

> Code example: `app/(dashboard)/leads/page.tsx`.

---

## Query in `page.tsx`. Render in the view.

A page is an `async` Server Component with no `'use client'` directive. It
queries through `db`, shapes the result, then passes it to one client view
component. A page contains no other markup.

```tsx
// app/(dashboard)/leads/page.tsx
export default async function LeadsPage() {
  const allLists = await db.select().from(lists).orderBy(lists.createdAt)
  // ...
  return <LeadsView lists={listsWithCount} leads={allLeads} />
}
```

This app has no data-fetching layer, no repository, and no `useEffect` fetch. If
a page needs data, query in the body of the page.

## Select the columns that the client needs

`page.tsx` selects the whole `lists` row. For `leads` it selects the seven
columns that the table renders. It leaves `openingLine` and `customFields`
behind.

```ts
const allLeads = await db
  .select({
    id: leads.id,
    listId: leads.listId,
    firstName: leads.firstName,
    lastName: leads.lastName,
    email: leads.email,
    company: leads.company,
    status: leads.status,
  })
  .from(leads)
  .orderBy(leads.createdAt)
```

## Aggregate in SQL. Join in JavaScript.

Counts come from a `groupBy` query. A `Map` then attaches them to the parent
rows. The code uses no SQL join.

```ts
const leadCounts = await db
  .select({ listId: leads.listId, count: count() })
  .from(leads)
  .groupBy(leads.listId)

const countMap = new Map(leadCounts.map((r) => [r.listId, r.count]))
const listsWithCount = allLists.map((l) => ({ ...l, leadCount: countMap.get(l.id) ?? 0 }))
```

## Convert every `Date` to a string in the page

Drizzle returns a `timestamp` column as a JavaScript `Date`. Serialize it before
it crosses to the client:

```ts
createdAt: l.createdAt.toISOString(),
```

The client type then declares `createdAt: string`. See `ListWithCount` in
`leads-view.tsx`.

CAUTION: If you omit this call, the failure appears at runtime, not at compile
time. The prop type says `string`. The value arrives as a `Date`. The format code
then fails.

The MCP code applies the same rule with a shared serializer in
`lib/mcp/tools/shared.ts`:

```ts
JSON.stringify(data, (_key, value) => (value instanceof Date ? value.toISOString() : value), 2)
```

## Put shared server helpers in `lib/`

If two or more features need the same server logic, write it in `lib/`. Write it
as an exported async function with a typed input. Do not write it as a Server
Action, because the client never calls it.

```ts
// lib/enqueue-leads.ts
export type EnqueueCampaign = { id: number; listId: number | null; /* ... */ }
export async function enqueueNewLeads(campaign: EnqueueCampaign): Promise<number>
```

A `lib/` file carries no `'use server'` directive. Server Actions, pages, and the
background loops in `instrumentation.ts` import these files.
