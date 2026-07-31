# `@workspace/core` Backend Guidelines

> Business logic only. This package runs on Node. It contains no React, no
> database access, and no framework imports.

---

## What this package is

`packages/core` holds the logic that `apps/web` imports. It does not depend on
`@workspace/db`, on Next.js, or on React. It renders nothing.

This package has no frontend layer. Do not create one.

## Guidelines index

| Guide | Subject |
|---|---|
| [Module Guidelines](./module-guidelines.md) | Module shape, exports, typed contracts, pure functions |

## Commands

`packages/core/package.json` declares one script:

```bash
pnpm --filter @workspace/core typecheck    # tsc --noEmit
```

This package has no build step. Consumers import the TypeScript source through
the `exports` map. This package also has no lint script and no test script.

## Modules for the Leads CSV work

| Module | Import specifier | Function |
|---|---|---|
| `src/csv.ts` | `@workspace/core/csv` | Parse CSV, detect columns, map rows |

The other modules are `spintax`, `variables`, `crypto`, `rotation`, and
`email/*`. They follow the same rules. This task does not spec them.
