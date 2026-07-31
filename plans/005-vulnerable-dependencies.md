# Plan 005: Clear the high-severity advisories in the dependency tree

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 57408de..HEAD -- package.json pnpm-lock.yaml packages/core/package.json packages/db/package.json packages/ui/package.json apps/web/package.json`
> If any in-scope file changed since this plan was written, re-run
> `pnpm audit --prod` and compare against the table below before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (Nodemailer is a three-major-version jump on the actual send
  path; a regression here means no email goes out at all)
- **Depends on**: plans/001-test-baseline.md (the core tests are the only
  automated signal that the upgrades didn't break anything)
- **Category**: dependencies
- **Planned at**: commit `57408de`, 2026-07-20

## Why this matters

`pnpm audit --prod` reports **13 advisories, 5 of them high**, against the
production dependency tree. Two sit directly on code paths this application
exercises on every send:

- **`nodemailer` is pinned at `^6.10.1`** and resolves to `6.10.1`. Six
  advisories apply, two high: a raw-message option that bypasses
  `disableFileAccess`/`disableUrlAccess` (fixed in 9.0.1) and a
  recursive-parsing DoS in `addressparser` (fixed in 7.0.11). The moderate ones
  include CRLF injection in transport headers and improper TLS certificate
  validation. This is the library that opens SMTP connections and sends the
  mail.
- **`drizzle-orm` resolves to `0.44.7`** in both `apps/web` and `packages/db`.
  A high-severity advisory covers SQL injection via improperly escaped SQL
  identifiers, fixed in `0.45.2`. This application does build raw fragments with
  the `sql` template tag — for example `eq(sql\`lower(${leads.email})\`, email)`
  in `apps/web/app/(dashboard)/inbox/actions.ts:111` — so the escaping behavior
  of the ORM is load-bearing here.

Two more high advisories (`brace-expansion`, `js-yaml`) come in through a single
avoidable path: **`shadcn` is declared as a runtime `dependency` of
`packages/ui`**, but it is a code-generation CLI that is only ever invoked
manually (`pnpm dlx shadcn@latest add ...`, per `CLAUDE.md`). Moving it to
`devDependencies` removes it from the production tree and clears both.

## Current state

Declared versions:

- `packages/core/package.json` → `"nodemailer": "^6.10.1"` (and
  `"@types/nodemailer": "^6.4.17"` in devDependencies)
- `packages/db/package.json` → `"drizzle-orm": "^0.44.2"`
- `apps/web/package.json` → `"drizzle-orm": "^0.44.2"`
- `packages/ui/package.json` → `"shadcn": "^4.11.0"` **under `dependencies`**
- Root `package.json` → `"drizzle-kit": "^0.31.1"` in devDependencies
- Root `package.json` has **no `pnpm.overrides` block**

Current `pnpm audit --prod` output, summarized:

| Severity | Package | Fixed in | Path |
|---|---|---|---|
| high | drizzle-orm | >=0.45.2 | `apps__web>drizzle-orm` |
| high | nodemailer | >=9.0.1 | `packages__core>nodemailer` |
| high | nodemailer | >=7.0.11 | `packages__core>nodemailer` |
| high | js-yaml | >=4.3.0 | `packages__ui>shadcn>cosmiconfig>js-yaml` |
| high | brace-expansion | >=5.0.7 | `packages__ui>shadcn>ts-morph>@ts-morph/common>minimatch>brace-expansion` |
| moderate ×5 | nodemailer | various | `packages__core>nodemailer` |
| moderate | js-yaml | >=4.2.0 | `packages__ui>shadcn>cosmiconfig>js-yaml` |
| moderate | postcss | >=8.5.10 | `apps__web>next>postcss` |
| low | nodemailer | >=8.0.4 | `packages__core>nodemailer` |

### The Nodemailer surface this app actually uses

Only one file constructs or drives a transport,
`packages/core/src/email/transport.ts`. The complete API surface is:

`transport.ts:120-136`:

```ts
export function buildTransport(config: SMTPConfig): Transporter {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    // When not using implicit TLS (port 465), require the server to upgrade via
    // STARTTLS rather than silently falling back to a plaintext connection.
    requireTLS: !config.smtpSecure,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });
}
```

plus `transport.verify()` (`transport.ts:147`), `transport.close()`
(`transport.ts:155`, `:185`), and one `transport.sendMail(mailOptions)` call
with `from`, `to`, `subject`, `html`, `text`, `replyTo`, `messageId`,
`inReplyTo`, `references` (`transport.ts:170-182`). The types `Transporter` and
`SendMailOptions` are imported from `nodemailer` at `transport.ts:11-12`.

That is a small and stable surface, which is why a three-major jump is
tractable. The risk is in behavior, not signatures.

### Drizzle usage

Drizzle is used throughout `apps/web` and defines the schema in
`packages/db/src/schema.ts`. The query builder API (`select`, `insert`,
`update`, `onConflictDoUpdate`, `innerJoin`, `leftJoin`, `returning`, and the
operators `eq`/`and`/`or`/`lt`/`lte`/`gte`/`isNotNull`/`inArray`/`asc`/`desc`/`sql`)
is used extensively. **`packages/db` and `apps/web` must always resolve to the
same drizzle-orm version** — a mismatch produces confusing type errors across
the workspace boundary.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Audit | `pnpm audit --prod` | see Done criteria |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | exit 0, all pass |
| Build | `pnpm build` | exit 0 |
| Migrations | `pnpm db:generate` | **must produce no new migration file** |

## Scope

**In scope**:
- `packages/core/package.json` (nodemailer + @types/nodemailer)
- `packages/db/package.json` (drizzle-orm)
- `apps/web/package.json` (drizzle-orm)
- `packages/ui/package.json` (move `shadcn` to devDependencies)
- `package.json` (root — add a `pnpm.overrides` block only if Step 5 requires it)
- `pnpm-lock.yaml`
- `packages/core/src/email/transport.ts` — **only** if the upgrade requires a
  code change, and only the minimum needed

**Out of scope** (do NOT touch):
- Upgrading `next`, `react`, or `react-dom`. The `postcss` moderate advisory
  arrives through `next`; a Next.js major upgrade is a separate project given
  the Next 16 breaking-change surface this repo already navigates. Handle it
  with an override or leave it, per Step 5.
- Any behavioral change to `transport.ts` beyond what the upgrade forces.
  Improving header handling is plan-worthy on its own.
- `packages/db/drizzle/**` — the generated migration SQL and snapshots. If a
  drizzle-orm upgrade wants to rewrite these, that is a STOP condition.
- The database schema in `packages/db/src/schema.ts`.
- `drizzle-kit` in the root devDependencies, unless the drizzle-orm upgrade
  explicitly requires a matching kit version (check the release notes; if it
  does, upgrade it and say so in your report).

## Git workflow

- Branch: `advisor/005-vulnerable-dependencies`
- **One commit per dependency**, so a bisect can isolate a regression:
  `chore: move shadcn to devDependencies`, `chore: upgrade drizzle-orm to
  0.45.x`, `chore: upgrade nodemailer to 9.x`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record the baseline

Run and save the output of:

```bash
pnpm audit --prod 2>&1 | tail -5
```

Note the exact counts. You will compare against these at the end.

**Verify**: you have recorded a line of the form
`N vulnerabilities found / Severity: ...`.

### Step 2: Move `shadcn` out of the production tree

In `packages/ui/package.json`, move the `"shadcn": "^4.11.0"` entry from
`"dependencies"` to `"devDependencies"`. Keep the same version specifier.

This is safe: `shadcn` is a CLI. `CLAUDE.md` documents the only way it is
invoked — `pnpm dlx shadcn@latest add <component> -c apps/web` — which downloads
it on demand and does not read the workspace dependency at all. No source file
imports it; confirm with the verification below.

Then `pnpm install`.

**Verify**:
- `grep -rn "from ['\"]shadcn" packages/ui/src apps/web` → **no matches**
- `pnpm audit --prod 2>&1 | tail -3` → the `js-yaml` and `brace-expansion`
  advisories are gone; total drops by 3 (2 js-yaml + 1 brace-expansion)
- `pnpm build` → exit 0

Commit.

### Step 3: Upgrade `drizzle-orm`

Set the specifier to `^0.45.2` (or the current latest 0.45.x) in **both**
`packages/db/package.json` and `apps/web/package.json`. They must match.

```bash
pnpm add --filter @workspace/db drizzle-orm@^0.45.2
pnpm add --filter web drizzle-orm@^0.45.2
```

Before running anything else, read the drizzle-orm release notes between 0.44
and the version you installed for breaking changes affecting the SQLite/
better-sqlite3 driver or the `sql` template tag.

**Verify**:
- `pnpm list --depth 0 --filter @workspace/db drizzle-orm` and the same for
  `--filter web` → identical versions, both `>= 0.45.2`
- `pnpm typecheck` → exit 0
- `pnpm build` → exit 0
- `pnpm db:generate` → **reports no schema changes and creates no new file in
  `packages/db/drizzle/`.** Confirm with `git status --porcelain packages/db/drizzle`
  → no output. If a migration is generated, that is a STOP condition.
- `pnpm audit --prod 2>&1 | tail -3` → the drizzle-orm high advisory is gone

Commit.

### Step 4: Upgrade `nodemailer`

```bash
pnpm add --filter @workspace/core nodemailer@^9.0.1
pnpm add -D --filter @workspace/core @types/nodemailer@latest
```

**Before changing anything else, read the Nodemailer changelog for the 7.0, 8.0
and 9.0 majors.** The API surface this repo uses is listed in "Current state"
above — check each of `createTransport`, `verify`, `close`, `sendMail`, and the
`Transporter` / `SendMailOptions` types against the release notes.

Two specific things to confirm, because this repo depends on them:

1. **`requireTLS: !config.smtpSecure`** (`transport.ts:127`) still forces
   STARTTLS rather than allowing a silent plaintext fallback. The comment above
   that line states the intent; if the option's semantics changed, the fix must
   preserve the intent, and you must call it out in your report.
2. **`messageId` is still used verbatim** when supplied. `transport.ts:38-40`
   documents that guarantee, and `apps/web/lib/scheduler.ts:493` stores the
   value it passed in as the sent message's ID. If Nodemailer now rewrites or
   ignores a supplied `messageId`, **STOP** — reply threading (`inReplyTo` /
   `references` in `scheduler.ts:394-403`) silently breaks, and no test in this
   repo would catch it.

If `@types/nodemailer` no longer exists as a separate package because
Nodemailer now ships its own types, remove the `@types/nodemailer`
devDependency and say so in your report.

**Verify**:
- `pnpm typecheck` → exit 0
- `pnpm lint` → exit 0
- `pnpm test` → exit 0 (the `appendUnsubscribeFooter` and `buildMessageId` tests
  from plan 001 import this module, so a broken import surfaces here)
- `pnpm build` → exit 0
- `pnpm audit --prod 2>&1 | tail -3` → **zero** nodemailer advisories

Commit.

### Step 5: Decide what to do about the remaining `postcss` advisory

After Steps 2–4, the only advisory that should remain is moderate `postcss`
(`apps__web>next>postcss`, fixed in `>=8.5.10`), which is transitive through
Next.js.

Check whether a `pnpm.overrides` entry resolves it without breaking the build:

```json
{
  "pnpm": {
    "overrides": {
      "postcss": ">=8.5.10"
    }
  }
}
```

in the **root** `package.json`, then `pnpm install` and `pnpm build`.

- If the build passes → keep the override and note it.
- If the build fails → **remove the override**, leave the advisory in place, and
  record in your report that it is accepted-and-deferred pending a Next.js
  upgrade. Do not force it. A moderate CSS-stringifier XSS reachable only
  through the build toolchain is not worth a broken build.

**Verify**: `pnpm build` → exit 0, whichever branch you took.

### Step 6: Verify the send path still works end to end

The automated tests do not cover actually sending mail. Do a real check.

If the operator has provided working SMTP credentials in this environment, use
the Connections page's "test connection" flow to confirm `verifyConnection`
succeeds against a live server.

If no credentials are available — **which is the expected case** — do not invent
any and do not send test mail to a real address. Instead, state plainly in your
report: *"Nodemailer upgraded from 6.10.1 to <version>; typecheck, lint, tests
and build pass; the live SMTP send path was NOT exercised and needs manual
verification before this is deployed."* That is an honest result. Claiming the
send path is verified when it is not is worse than leaving it unverified.

**Verify**: your report contains one of the two statements above.

## Test plan

No new tests are written by this plan. The existing suite from plan 001 acts as
the regression signal, in particular
`packages/core/src/email/transport.test.ts`, which imports the module that pulls
in Nodemailer.

The honest coverage gap: nothing in this repo tests an actual SMTP conversation.
Step 6 exists to make that gap explicit rather than to paper over it.

## Done criteria

ALL must hold:

- [ ] `pnpm install` exits 0 with no peer-dependency errors
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0, with every test from plans 001–003 still passing
- [ ] `pnpm build` exits 0
- [ ] `pnpm db:generate` produces no new migration
      (`git status --porcelain packages/db/drizzle` → empty)
- [ ] `pnpm audit --prod` reports **0 high** advisories
- [ ] `pnpm audit --prod` reports **0** advisories for `nodemailer`,
      `drizzle-orm`, `js-yaml`, and `brace-expansion`
- [ ] `grep -n '"shadcn"' packages/ui/package.json` shows it under
      `devDependencies`
- [ ] `packages/db` and `apps/web` resolve to the **same** drizzle-orm version
- [ ] `git diff 57408de..HEAD -- packages/db/drizzle packages/db/src/schema.ts`
      shows no changes
- [ ] Your report states explicitly whether the live SMTP send path was
      exercised
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm db:generate` wants to create a migration after the drizzle upgrade. That
  means the ORM's interpretation of the schema changed, which is a data-model
  question, not a dependency question.
- The Nodemailer changelog says `messageId` is no longer honored verbatim, or
  `requireTLS` semantics changed. Both are load-bearing here; report before
  adapting the code.
- `pnpm typecheck` produces more than a handful of errors after an upgrade, or
  errors in files outside `packages/core/src/email/transport.ts` and the drizzle
  query sites. A wide type break means the major jump needs its own plan.
- Any test from plans 001–003 fails.
- You are tempted to upgrade `next`, `react`, or `react-dom` to clear the
  `postcss` advisory. Out of scope — see Step 5.
- After all steps, `pnpm audit --prod` still reports a high advisory you cannot
  resolve. Report which one and why rather than forcing an override that breaks
  the build.

## Maintenance notes

- **Nodemailer 6 → 9 is the risky part of this change and it has no automated
  coverage.** A reviewer should treat Step 6's honesty statement as the key
  artifact and arrange a real send test before deploying.
- If the `postcss` override was added in Step 5, it must be **removed** when
  Next.js is next upgraded — a stale override silently pins a transitive
  dependency below what the framework expects.
- `pnpm audit --prod` is worth running in CI once CI exists. There is no CI
  configuration in this repo today (no `.github/`), which is why this drifted to
  13 advisories unnoticed.
- Keep `drizzle-orm` in `packages/db` and `apps/web` pinned to the same
  specifier. A future contributor bumping only one will get type errors that
  look like schema bugs.
