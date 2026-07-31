# `apps/web` Backend Guidelines

> Server Actions, Server Components, Route Handlers, and the `lib/` helpers.

---

## What counts as backend code

`apps/web` has no separate server directory. Two things identify server code: its
location and its directive.

| Kind | Location | Marker |
|---|---|---|
| Server Action | `app/(dashboard)/<feature>/actions.ts` | `'use server'` at the top of the file |
| Server Component | `app/(dashboard)/<feature>/page.tsx` | `async` default export, no `'use client'` |
| Route Handler | `app/api/<name>/route.ts` | An exported `GET`, `POST`, or other method |
| Shared server helper | `lib/*.ts` | No directive. Only the code above imports it. |

Any file that imports `@workspace/db` is server code.

## Guidelines index

| Guide | Subject |
|---|---|
| [Server Actions](./server-actions.md) | Action shape, return types, revalidation, validation |
| [Data Loading](./data-loading.md) | Server Component queries and the server-to-client boundary |

## Directory layout

One feature owns one directory. These three files always sit together:

```
app/(dashboard)/leads/
├── page.tsx          # Server Component: queries, then renders the view
├── actions.ts        # 'use server': all mutations for this feature
└── leads-view.tsx    # 'use client': the whole user interface
```

If two or more features need the same logic, move it to `lib/`. Two examples are
`lib/enqueue-leads.ts` and `lib/unsubscribe-footer.ts`. Do not put shared logic in
the `actions.ts` file of another feature.

## Commands

```bash
pnpm --filter web dev         # next dev
pnpm --filter web build       # next build
pnpm --filter web lint        # eslint
pnpm --filter web typecheck   # tsc --noEmit
pnpm --filter web format      # prettier --write "**/*.{ts,tsx}"
```

From the root, Turborepo fans out `pnpm build`, `pnpm lint`, and `pnpm typecheck`
across all workspaces.

## Route Handlers

The app has one Route Handler: `app/api/mcp/route.ts`. It sets both runtime flags
and gives the reason in the file:

```ts
// This route must run in the Node.js runtime — crypto, better-sqlite3,
// and the scheduler all require Node APIs unavailable in Edge.
export const runtime = 'nodejs'
// Never cache; each request is a live RPC call.
export const dynamic = 'force-dynamic'
```

If you add a route that touches `@workspace/db`, add the same two exports.

Prefer a Server Action to a new Route Handler. Mutations in this app go through
`actions.ts`. The `/api/mcp` route exists because an external MCP client speaks
HTTP.

## Authentication

Server Actions and dashboard pages have no authentication. The one authentication
check is `lib/mcp/auth.ts`, and it guards `/api/mcp` only.

```ts
// requireBearer: constant-time compare against a token in app_settings,
// with a fallback to process.env['MCP_API_KEY']
const a = Buffer.from(token, 'utf8')
const b = Buffer.from(provided, 'utf8')
if (a.length !== b.length) return false
return timingSafeEqual(a, b)
```

If you add authentication to the dashboard later, copy this pattern. Store the
token encrypted in `app_settings`. Compare it with `timingSafeEqual`. Never
compare it with `===`.

## Logging

This app has no logger. `console.*` appears in two files only:
`lib/scheduler.ts` and `lib/inbox-poller.ts`. Both files run long background
loops that `instrumentation.ts` starts. Server Actions and Route Handlers write
no logs.

Do not leave a `console.log` in a Server Action after you debug it.

CAUTION: Never log decrypted credentials. See the security rules in `CLAUDE.md`.
