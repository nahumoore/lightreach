# `@workspace/db` Backend Guidelines

> The Drizzle ORM schema and the SQLite client. Server code only.

---

## What this package is

`packages/db` owns three things: the schema in `src/schema.ts`, the client
singleton in `src/client.ts`, and the generated migrations in `drizzle/`.

Only server code in `apps/web` imports this package. That code is Server
Components, Server Actions, Route Handlers, and `instrumentation.ts`.

Never import `@workspace/db` from a `'use client'` file. This package has no
frontend layer. Do not create one.

## Guidelines index

| Guide | Subject |
|---|---|
| [Schema Guidelines](./schema-guidelines.md) | Table shape, columns, indexes, migration steps |

## Commands

Run these from the repo root. The root `package.json` passes them to this
package.

```bash
pnpm db:generate   # drizzle-kit generate: write a new SQL migration from schema.ts
pnpm db:migrate    # drizzle-kit migrate:  apply pending migrations to data.db
pnpm db:studio     # drizzle-kit studio:   browse data
```

Type checking is the only other script:

```bash
pnpm --filter @workspace/db typecheck    # tsc --noEmit
```

This package has no build script and no test script.

## Node version

Use Node 22. The repo pins it in `.nvmrc`.

`better-sqlite3` is a native module. Version `11.10.0` ships prebuilt binaries
for Node 18 to 23 only.

CAUTION: On a later Node release, `prebuild-install` finds no binary and falls
back to `node-gyp`. If `node-gyp` is absent, `pnpm install` stops before it links
any `.bin` directory. Every workspace script then fails with
`sh: tsc: command not found`, which hides the real cause.

If you see that error, first run `node -v`.

## Tables for the Leads CSV work

| Table | Symbol | Location |
|---|---|---|
| `lists` | `lists` | `src/schema.ts:59` |
| `leads` | `leads` | `src/schema.ts:70` |

The other nine tables follow the same rules. This task does not spec them.
