# Module Guidelines for `@workspace/core`

> The code example for every rule below is `packages/core/src/csv.ts`.

---

## Export each module through one subpath

A new module is not importable until you add it to the `exports` map in
`packages/core/package.json`. This package has no root barrel file. Deep file
imports do not work.

```jsonc
// packages/core/package.json
"exports": {
  "./spintax": "./src/spintax.ts",
  "./csv": "./src/csv.ts",
  "./email/transport": "./src/email/transport.ts"
}
```

Consumers import the subpath. They never import the file path.

```ts
// apps/web/app/(dashboard)/leads/leads-view.tsx:61
import { parseCSV, detectMapping, mapCSVRows, LEAD_FIELDS } from '@workspace/core/csv'
import type { ColumnMapping } from '@workspace/core/csv'
```

To add a module, make two edits: write the file, then add the `exports` entry.

## Start each module with a JSDoc block that gives the usage order

The block in `csv.ts` names the supported fields. It also gives the three steps
that a consumer calls in order. A reader can then use the module without reading
the body.

```ts
/**
 * CSV parsing + column-mapping helpers for the lead import wizard.
 *
 * Usage flow:
 *   1. User uploads CSV  →  parseCSVHeaders() to get available columns
 *   2. User maps columns  →  ColumnMapping object
 *   3. mapCSVRows()  →  MappedLead[]  ready to insert
 */
```

CAUTION: This block names `parseCSVHeaders()`. The exported function is
`parseCSV()` at `csv.ts:60`. If you edit this file, correct the header comment.

## Keep exported functions pure and synchronous

`parseCSV`, `detectMapping`, and `mapCSVRows` accept data and return data. They
run no input and output operations. They import no `db`. They read no
`process.env`. They throw no errors for control flow.

As a result, the wizard calls them in the browser at `leads-view.tsx:501` and
`:503`. The server calls the same functions.

If your code needs input or output operations, put it in `apps/web/lib/` or in a
Server Action. Do not put it here.

## Export a named type for each stage

Each stage of the flow has one exported type. Banner comments divide the file
into `Types`, `Parsing`, and `Helpers` sections.

```ts
export const LEAD_FIELDS = ['firstName', 'lastName', 'email', 'company', 'openingLine'] as const
export type LeadField = (typeof LEAD_FIELDS)[number]
export type ColumnMapping = Partial<Record<LeadField, string>>
export interface MappedLead { /* ... */ }
export interface ParseResult { headers: string[]; rows: Record<string, string>[]; errors: string[] }
```

`LeadField` comes from the `as const` array. The field names are written once. If
you add a field to `LEAD_FIELDS`, `ColumnMapping` gets it too. The consumer reads
the same constant to build its user interface at `leads-view.tsx:61`.

`MappedLead` is the contract for the Server Action. `importLeads` accepts
`rows: MappedLead[]` at `leads/actions.ts:21` and imports the type from
`@workspace/core/csv`. If you change `MappedLead`, you change the input of that
Server Action.

## Filter invalid input. Do not throw.

`mapCSVRows` drops each row that has no email address:

```ts
const email = pick(row, mapping.email)
if (!email) return null // email is required
```

The function then narrows the array with a type predicate:
`.filter((r): r is MappedLead => r !== null)`.

`parseCSV` returns parse errors as data:

```ts
return { headers: result.meta.fields ?? [], rows: result.data, errors: result.errors.map((e) => e.message) }
```

The caller decides what to do with `errors`. This package does not decide.

## Keep private helpers unexported at the end of the file

`pick(row, col)` at `csv.ts:135` sits under the `Helpers` banner comment. It is
local to the module. If one module uses a helper, do not export it and do not
move it to a shared file.

## Style

`packages/core` uses double quotes and semicolons. `apps/web` uses single quotes
and no semicolons. Prettier accepts both. Match the file that you edit, not the
other package.
