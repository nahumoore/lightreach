# Lightreach Spec Index

> Coding specs for each package. A real file in this repo supports every rule.
> These documents record what the code does now. They do not record plans.

---

## Package map

`pnpm-workspace.yaml` includes `apps/*` and `packages/*`. This bootstrap covers
only the packages that the Leads CSV work changes.

| Package | Layer | Spec | Status |
|---|---|---|---|
| `apps/web` | backend | [web/backend](./web/backend/index.md) | Specced |
| `apps/web` | frontend | [web/frontend](./web/frontend/index.md) | Specced |
| `packages/core` | backend | [core/backend](./core/backend/index.md) | Specced |
| `packages/db` | backend | [db/backend](./db/backend/index.md) | Specced |
| `packages/ui` | frontend | none | **Not yet specced.** `apps/web` imports it. This work does not change it. |
| `packages/eslint-config` | none | none | **Not yet specced.** Configuration only, no application code. |
| `packages/typescript-config` | none | none | **Not yet specced.** Configuration only, no application code. |

The [thinking guides](./guides/index.md) apply to all packages.

`packages/core` and `packages/db` run on Node only. They have no frontend layer.
`packages/eslint-config` and `packages/typescript-config` contain no TypeScript
source. Do not create `frontend/` directories for these four packages.

## What these specs cover

The examples come from the Leads CSV import flow. That flow is
`app/(dashboard)/leads/*`, `packages/core/src/csv.ts`, and the `lists` and
`leads` tables. The rules apply to the whole package.

| Subject | File |
|---|---|
| Server Actions, return types, validation | [web/backend/server-actions.md](./web/backend/server-actions.md) |
| Server Component queries, server-to-client boundary | [web/backend/data-loading.md](./web/backend/data-loading.md) |
| Route handlers, authentication, logging, commands | [web/backend/index.md](./web/backend/index.md) |
| Components, props, dialogs, styles | [web/frontend/component-guidelines.md](./web/frontend/component-guidelines.md) |
| Local state, transitions, multi-step wizards | [web/frontend/state-management.md](./web/frontend/state-management.md) |
| Core module shape, exports, pure functions | [core/backend/module-guidelines.md](./core/backend/module-guidelines.md) |
| Tables, columns, indexes, migrations | [db/backend/schema-guidelines.md](./db/backend/schema-guidelines.md) |

## Three things this repo does not have

These facts are recorded here, not in a spec file. No code example exists for
them.

1. **No tests.** No test file, no test runner, and no `test` script exists in any
   package. If you add tests, first select a runner. No existing layout is
   available to copy.
2. **No logger.** `console.*` appears in two files only:
   `apps/web/lib/scheduler.ts` and `apps/web/lib/inbox-poller.ts`. Both files run
   background loops. No structured logging exists.
3. **No dashboard authentication.** Server Actions and pages accept all
   requests. The only authentication check is the MCP bearer token in
   `apps/web/lib/mcp/auth.ts`. It guards `/api/mcp` only.

## Two patterns for one subject

Two patterns exist for two subjects. The specs record the dominant pattern. Do
not propagate the legacy pattern.

| Subject | Dominant | Legacy: do not propagate |
|---|---|---|
| Server Action failure | Result object `{ ok, error }` (`connections/actions.ts:129`) | `throw new Error` (`leads/actions.ts:68`, `:100`, and `settings/actions.ts`) |
| Sequence authoring | `sequences` and `sequence_steps` tables | `templates`. The route remains as one `redirect('/sequences')` call in `app/(dashboard)/templates/page.tsx`. |

## Commands for each package

| Package | dev | build | lint | typecheck | test |
|---|---|---|---|---|---|
| `apps/web` | `next dev` | `next build` | `eslint` | `tsc --noEmit` | none |
| `packages/core` | none | none. Consumers import the source. | none | `tsc --noEmit` | none |
| `packages/db` | none | none | none | `tsc --noEmit` | none |
| `packages/ui` | none | none | `eslint` | `tsc --noEmit` | none |

Turborepo fans out the root commands `pnpm build`, `pnpm lint`, `pnpm typecheck`,
and `pnpm format`. Run database commands from the root: `pnpm db:generate`,
`pnpm db:migrate`, and `pnpm db:studio`.
