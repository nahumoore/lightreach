# Schema Guidelines for `@workspace/db`

> Code examples: `packages/db/src/schema.ts`, `src/client.ts`, and
> `src/index.ts`.

---

## Put every table in one file, under a banner comment

All tables live in `src/schema.ts`. Each `sqliteTable` call defines one entity. A
banner comment above it gives the table name and its function.

```ts
// ---------------------------------------------------------------------------
// leads — individual contacts
// ---------------------------------------------------------------------------
export const leads = sqliteTable("leads", { /* ... */ })
```

The exported symbol uses camelCase. The SQL table name uses snake_case.

## Column rules

This example comes from `leads` at `schema.ts:70`:

```ts
id: integer("id").primaryKey({ autoIncrement: true }),
listId: integer("list_id")
  .notNull()
  .references(() => lists.id, { onDelete: "cascade" }),
firstName: text("first_name").notNull().default(""),
email: text("email").notNull(),
customFields: text("custom_fields", { mode: "json" })
  .$type<Record<string, string>>()
  .default({}),
status: text("status").notNull().default("new"),
createdAt: integer("created_at", { mode: "timestamp" })
  .notNull()
  .default(sql`(unixepoch())`),
```

The rules in that example are:

- **Write the property in camelCase and the column name in snake_case.** Always
  pass the SQL name, even when the two names match.
- **Give optional text `.notNull().default("")`. Do not make it nullable.** The
  columns `firstName`, `lastName`, `company`, and `openingLine` all default to an
  empty string. For this reason `mapCSVRows` fills unmapped fields with `""`
  instead of `undefined`. See `packages/core/src/csv.ts`. Do not add a nullable
  text column for an optional lead field.
- **Write timestamps as `integer(..., { mode: "timestamp" })` with the default
  `sql\`(unixepoch())\`.** Drizzle returns these columns as JavaScript `Date`
  objects.
- **Write booleans as `integer(..., { mode: "boolean" })`.** See
  `connections.smtpSecure` at `schema.ts:20`.
- **Store free-form key and value data as
  `text(..., { mode: "json" }).$type<T>()`.** Unmapped CSV columns land in
  `leads.customFields`.
- **Write enum columns as plain `text` with a comment that lists the values.**
  The database holds no constraint for them.
  ```ts
  /** 'new' | 'contacted' | 'replied' | 'bounced' | 'unsubscribed' */
  status: text("status").notNull().default("new"),
  ```
- **Declare `onDelete` on every foreign key, and pass the target as a thunk.**
  `leads.listId` cascades. For this reason `deleteList` runs one delete only. See
  `apps/web/app/(dashboard)/leads/actions.ts:16`.

## Declare indexes in the third argument of `sqliteTable`

A table that needs indexes takes a callback that returns an array:

```ts
// schema.ts:230
index("messages_status_scheduled_idx").on(table.status, table.scheduledAt),
uniqueIndex("inbound_email_uid_unique").on(table.connectionId, table.uid),
```

CAUTION: The `leads` table has no unique index on `email`. Application code
enforces uniqueness instead. `importLeads` loads the existing emails into a `Set`
and filters the new rows at `leads/actions.ts:21`. `createLead` reads first, then
inserts, at `:68`. If you add a unique constraint, both checks become redundant
and both insert paths must handle constraint violations.

## Import the client. Never construct a second one.

The client is a module-level singleton:

```ts
// src/client.ts
const sqlite = new Database(dbPath)
sqlite.pragma("journal_mode = WAL")
export const db = drizzle(sqlite, { schema })
export type DB = typeof db
```

`dbPath` comes from `process.env["DATABASE_URL"]` after the code deletes the
`file:` prefix. The fallback is `data.db` in the working directory.

Never call `new Database` or `drizzle()` anywhere else. Import `db` instead.

The code reads environment variables with bracket syntax and always gives a
fallback. `noUncheckedIndexedAccess` is on in
`packages/typescript-config/base.json`. Every indexed read is therefore
`string | undefined` and needs narrowing.

## Import from the package root

`src/index.ts` is the whole public surface:

```ts
export { db } from "./client";
export type { DB } from "./client";
export * from "./schema";
```

One import gives you the tables and the client. Query operators come from
`drizzle-orm`:

```ts
// apps/web/app/(dashboard)/leads/actions.ts:2
import { db, lists, leads } from '@workspace/db'
import { eq, and, not } from 'drizzle-orm'
```

The `exports` map also holds the `./schema` and `./client` subpaths. Application
code uses the root import.

## Migration steps

Drizzle generates the migrations. Do not write them by hand. The repo holds them
in `packages/db/drizzle/`, currently `0000` to `0009`.

1. Edit `packages/db/src/schema.ts`.
2. Run `pnpm db:generate`. The command writes the next `drizzle/NNNN_*.sql` file.
3. Run `pnpm db:migrate`. The command applies that file to `data.db`.
4. Commit the generated `.sql` file together with the `schema.ts` change.

In Docker, the `migrate` service runs `pnpm db:migrate` once before `web` starts.
A schema change therefore reaches production only when the migration file is in
the repo.

You can rename a generated file to describe the change. The files
`0004_add_sequences.sql` and `0008_rename_is_warmup.sql` were renamed. The others
keep their generated names. Both forms are correct.
