# Plan 001: Establish a working test harness and cover the pure logic in `@workspace/core`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 57408de..HEAD -- packages/core packages/db package.json turbo.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `57408de`, 2026-07-20

## Why this matters

This repository has **zero tests, no test runner installed, and no CI**. The
code that decides *when* an email is sent (timezone and DST arithmetic), *which
mailbox* sends it (round-robin under daily limits), and *what the recipient
sees* (spintax expansion, variable substitution, opt-out footer escaping) is all
untested. A cold-email tool that miscalculates a send window emails people at
3am; one that miscounts daily limits gets its sending domain blocked.

Three other plans in this directory (002, 003, 005) change behavior in exactly
these modules. Without a runner they land blind. This plan installs the runner
and writes the first tests; it deliberately covers only pure functions with no
database or network dependency, so it can be completed and verified quickly.

## Current state

The modules in scope are pure and dependency-free — they take data in and
return data out, with no DB or network access. That is what makes them testable
without any fixture infrastructure.

- `packages/core/src/rotation.ts` — mailbox round-robin (`pickNext`), send-window
  checks (`isWithinSendWindow`), next-window arithmetic (`nextSendWindowStart`),
  timezone day boundaries (`startOfDayInTimezone`), jitter (`randomDelayMs`).
- `packages/core/src/spintax.ts` — `{a|b|c}` expansion.
- `packages/core/src/variables.ts` — `{{name|fallback}}` substitution.
- `packages/core/src/email/quote.ts` — splits a reply from its quoted history.
- `packages/core/src/email/transport.ts` — contains one pure function worth
  testing, `appendUnsubscribeFooter`, plus `buildMessageId`. **Note: importing
  this module pulls in `nodemailer`.** That is fine under Node but keep the test
  focused on the two pure exports.
- `packages/core/src/crypto.ts` — AES-256-GCM round-trip. Requires the
  `APP_ENCRYPTION_KEY` environment variable (64 hex chars); the test must set a
  throwaway key itself, see Step 5.

Key excerpts you will be testing against.

`packages/core/src/rotation.ts:35-64`:

```ts
export function pickNext(
  connections: ConnectionSlot[],
  state: RotationState,
): PickResult | null {
  const eligible = connections.filter(
    (c) =>
      c.status === "active" &&
      (state.sentTodayByConnection[c.id] ?? 0) < c.dailyLimit,
  );

  if (eligible.length === 0) return null;

  // Sort by id for stable ordering, then rotate from last-used position
  const sorted = [...eligible].sort((a, b) => a.id - b.id);

  let chosen: ConnectionSlot;
  if (state.lastUsedConnectionId === null) {
    chosen = sorted[0]!;
  } else {
    const lastIdx = sorted.findIndex((c) => c.id > state.lastUsedConnectionId!);
    chosen = lastIdx === -1 ? sorted[0]! : sorted[lastIdx]!;
  }

  const sentToday = state.sentTodayByConnection[chosen.id] ?? 0;

  return {
    connectionId: chosen.id,
    newSentCount: sentToday + 1,
  };
}
```

`packages/core/src/rotation.ts:76-112`:

```ts
export function isWithinSendWindow(
  now: Date,
  timezone: string,
  windowStart: string,
  windowEnd: string,
  daysOfWeek: number[],
): boolean {
  // ...formats `now` in `timezone`, maps weekday to 0-6...
  // Overnight windows (e.g. 22:00 -> 06:00) wrap past midnight, so "within window"
  // means outside the [end, start) gap rather than inside a simple [start, end) range.
  if (windowStart > windowEnd) {
    return currentTime >= windowStart || currentTime < windowEnd;
  }
  return currentTime >= windowStart && currentTime < windowEnd;
}
```

`packages/core/src/email/transport.ts:101-110`:

```ts
export function appendUnsubscribeFooter(
  html: string,
  footerText: string = DEFAULT_UNSUBSCRIBE_TEXT,
): string {
  const trimmed = footerText.trim() || DEFAULT_UNSUBSCRIBE_TEXT;
  // Preserve author line breaks (a sign-off + postal address is common) — the
  // Textarea editor lets users write multi-line footers.
  const body = escapeHtml(trimmed).replace(/\r?\n/g, "<br />");
  return `${html}<p style="color:#888888;font-size:12px;margin-top:24px;">${body}</p>`;
}
```

### Repo conventions you MUST follow

1. **`packages/core` uses `moduleResolution: "NodeNext"`** (see
   `packages/typescript-config/base.json`). Under NodeNext, **relative imports in
   TypeScript source must carry a `.js` extension** even though the file on disk
   is `.ts`. Write:

   ```ts
   import { pickNext } from "./rotation.js";        // CORRECT
   import { pickNext } from "./rotation";           // WRONG — `tsc --noEmit` fails
   ```

   The existing core modules have no relative imports, so there is no precedent
   file to copy. Follow the rule above.

2. **`packages/core` source style is double quotes and semicolons** (see
   `packages/core/src/rotation.ts`). Match it in the test files. Do not run
   Prettier — its root config specifies `singleQuote: false, semi: false`, which
   disagrees with the existing core sources; reformatting would produce a large
   unrelated diff.

3. **Import Vitest primitives explicitly**, do not rely on globals:

   ```ts
   import { describe, it, expect } from "vitest";
   ```

   This avoids needing a `types: ["vitest/globals"]` entry in the tsconfig.

4. **Test files live beside their subject**, inside `src/` (e.g.
   `packages/core/src/rotation.test.ts`). `packages/core/tsconfig.json` has
   `"include": ["src"]`, so tests placed there are typechecked by
   `pnpm typecheck` — that is intended.

5. **Package manager is pnpm.** Never use npm. The root
   `package.json` declares `"packageManager": "pnpm@10.33.4"`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Add root dev dep | `pnpm add -D -w <pkg>` | exit 0 |
| Add core dev dep | `pnpm add -D --filter @workspace/core <pkg>` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 |
| Tests (all) | `pnpm test` | exit 0, all pass |
| Tests (core only) | `pnpm --filter @workspace/core test` | exit 0, all pass |

## Scope

**In scope** (the only files you should modify or create):
- `package.json` (root) — add a `test` script
- `turbo.json` — register the `test` task
- `packages/core/package.json` — add `test` script + `vitest` dev dependency
- `packages/core/vitest.config.ts` (create)
- `packages/core/src/rotation.test.ts` (create)
- `packages/core/src/spintax.test.ts` (create)
- `packages/core/src/variables.test.ts` (create)
- `packages/core/src/crypto.test.ts` (create)
- `packages/core/src/email/quote.test.ts` (create)
- `packages/core/src/email/transport.test.ts` (create)
- `pnpm-lock.yaml` (will change as a result of installs — expected)

**Out of scope** (do NOT touch, even though they look related):
- **Any file under `packages/core/src/` other than the new `*.test.ts` files.**
  If a test reveals a bug, **write the test to assert the CURRENT behavior, add
  a `// TODO(plan-00X):` comment naming the suspected bug, and report it in your
  summary.** Do not fix it here. Fixing behavior in the same change that
  introduces its test destroys the evidence that the test would have caught it.
  Plans 003 and 005 exist to change behavior.
- `apps/web/**` — the web app uses the `@/` path alias and imports the database,
  which needs resolver and fixture setup this plan deliberately defers.
- `packages/core/src/csv.ts`, `packages/core/src/email/imap.ts`,
  `packages/core/src/email/dns.ts` — deferred; imap/dns need network mocking.
- Any dependency upgrade. Plan 005 handles that.

## Git workflow

- Branch: `advisor/001-test-baseline`
- Commit per step or per logical unit. The repo uses Conventional Commits —
  recent examples from `git log`: `refactor: centralize opt-out footer resolution
  in one server helper`, `feat: show opt-out footer in the sequence editor live
  preview`. Use `test:` for test-only commits and `chore:` for the harness setup.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Install Vitest

Run:

```bash
pnpm add -D --filter @workspace/core vitest
```

**Verify**: `pnpm --filter @workspace/core exec vitest --version` → prints a
version number, exit 0.

### Step 2: Add the Vitest config for `packages/core`

Create `packages/core/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

**Verify**: `pnpm --filter @workspace/core exec vitest run` → exits 0 with
"No test files found" (no tests exist yet — this is the expected output at this
step). If it exits non-zero for any other reason, STOP.

### Step 3: Wire the `test` task into the workspace

Add to `packages/core/package.json` under `"scripts"` (beside the existing
`"typecheck": "tsc --noEmit"`):

```json
"test": "vitest run"
```

Add to the root `package.json` under `"scripts"` (beside `"typecheck": "turbo typecheck"`):

```json
"test": "turbo test"
```

Add to `turbo.json` under `"tasks"` (beside the existing `"typecheck"` entry):

```json
"test": {
  "dependsOn": ["^build"]
}
```

**Verify**: `pnpm test` → exit 0. Turbo reports one package with a `test` task
and Vitest reports no test files found.

### Step 4: Write tests for `rotation.ts`

Create `packages/core/src/rotation.test.ts`. Cover, at minimum:

**`pickNext`**
- returns `null` when the connection list is empty.
- returns `null` when every connection has `status !== "active"`.
- returns `null` when every active connection has already reached `dailyLimit`.
- with `lastUsedConnectionId: null`, picks the lowest-id eligible connection.
- with `lastUsedConnectionId` set to an id in the middle of the set, picks the
  next-higher id.
- with `lastUsedConnectionId` set to the highest id, wraps around to the lowest.
- skips a connection that is at its `dailyLimit` and picks the next eligible one.
- returns `newSentCount` equal to that connection's current count plus one,
  defaulting the current count to 0 when the connection is absent from
  `sentTodayByConnection`.

**`isWithinSendWindow`** — pass explicit UTC instants via
`new Date("2026-07-20T14:00:00Z")` so results are deterministic. Use
`"America/New_York"` (UTC-4 in July) and `"UTC"`.
- an instant inside a normal `"09:00"`–`"17:00"` window on an allowed weekday →
  `true`.
- the same instant when its weekday is not in `daysOfWeek` → `false`.
- an instant before the window opens → `false`.
- an instant exactly at `windowStart` → `true` (the comparison is `>=`).
- an instant exactly at `windowEnd` → `false` (the comparison is `<`).
- an overnight window `"22:00"`–`"06:00"`: an instant at 23:00 local → `true`;
  at 02:00 local → `true`; at 12:00 local → `false`.
- the same UTC instant evaluated in two different timezones gives different
  results (this is the regression guard for the timezone handling).

**`startOfDayInTimezone`**
- for an instant during 2026-07-20 in `"America/New_York"`, returns the UTC
  instant corresponding to 2026-07-20T00:00 local (i.e. `2026-07-20T04:00:00Z`).
- for `"UTC"`, returns midnight UTC of the same calendar day.

**`nextSendWindowStart`**
- when `from` is already inside the window, returns `from` unchanged (assert
  identity of the timestamp value).
- when `from` is a weekday evening after the window closed, returns the next
  allowed day's `windowStart`.
- when `from` is a Friday evening and `daysOfWeek` is `[1,2,3,4,5]`, returns the
  following Monday's `windowStart`.
- when `daysOfWeek` is empty, returns `from` unchanged.

**`randomDelayMs`**
- with `min === max`, returns exactly `min * 1000`.
- with min/max supplied in reverse order (e.g. `randomDelayMs(60, 10)`), the
  result still falls within `[10_000, 60_000]`.
- over 100 iterations the result always falls within `[min*1000, max*1000]`.

**Verify**: `pnpm --filter @workspace/core test` → all tests pass, exit 0.

### Step 5: Write tests for the remaining modules

Create the following files with at least the listed cases.

`packages/core/src/spintax.test.ts` — read
`packages/core/src/spintax.ts` first and cover: a string with no spintax is
returned unchanged; `{a|b}` always yields `"a"` or `"b"`; nested braces behave as
the implementation defines; an unmatched `{` does not throw; an empty option
(`{a|}`) is handled. **Assert the behavior the code actually has** — run the
function to find out before writing the assertion.

`packages/core/src/variables.test.ts` — `{{firstName}}` substitutes the value;
a missing variable with no fallback yields an empty string; `{{name|fallback}}`
uses the fallback when the value is missing, empty, `null`, or `undefined`;
matching is case-insensitive (`{{FirstName}}` finds key `firstName`); multiple
placeholders in one string all substitute; `extractVariables` returns unique
lowercase names; `missingVariables` returns only the absent ones.

`packages/core/src/email/quote.test.ts` — `splitQuotedReply(null, null)` returns
`{ reply: "", quoted: null, isHtml: false }`; an HTML body containing
`<div class="gmail_quote">` splits at that marker with `isHtml: true`; an HTML
body with no marker returns the whole body as `reply` and `quoted: null`; a
plain-text body with an `"On ... wrote:"` attribution line splits there; a
plain-text body whose quoted part is only `>` characters returns `quoted: null`
(the `hasVisibleContent` guard); when both `bodyText` and `bodyHtml` are present,
the HTML path wins.

`packages/core/src/email/transport.test.ts` — for `appendUnsubscribeFooter`:
the default footer is appended when no `footerText` is given; an empty or
whitespace-only `footerText` falls back to `DEFAULT_UNSUBSCRIBE_TEXT`; **a
footer containing `<script>alert(1)</script>` appears HTML-escaped in the output
and the literal substring `<script>` does not appear**; newlines in the footer
become `<br />`. For `buildMessageId`: `buildMessageId("a@example.com", "uuid")`
returns `"<uuid@example.com>"`; an address with no `@` falls back to the
`localhost` domain.

`packages/core/src/crypto.test.ts` — this module reads `APP_ENCRYPTION_KEY` at
call time, so set it inside the test file before the assertions:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt } from "./crypto.js";

// Throwaway key for tests only — never a real one, never read from the
// developer's environment.
const TEST_KEY = "0".repeat(64);

beforeAll(() => {
  process.env["APP_ENCRYPTION_KEY"] = TEST_KEY;
});
```

Cover: `decrypt(encrypt(s)) === s` for an ASCII string, a string with emoji and
accents, and an empty string; encrypting the same plaintext twice produces
different ciphertexts (random IV); `decrypt` throws on a tampered ciphertext
(flip a character in the middle of the base64url string) — this proves the GCM
auth tag is being enforced.

**Do not put a real credential in any test file.** Use the all-zeros key above.

**Verify**: `pnpm --filter @workspace/core test` → all tests pass, exit 0.

### Step 6: Confirm the whole workspace is still green

**Verify** each of the following, in order:
- `pnpm typecheck` → exit 0. If it reports `Cannot find module './rotation'` or
  similar, you omitted the `.js` extension on a relative import — see convention
  1 above.
- `pnpm lint` → exit 0.
- `pnpm test` → exit 0, and the output reports the number of test files you
  created.
- `git status --porcelain` → lists only files from the "In scope" list.

## Test plan

This plan *is* the test plan. Target: at least 6 test files and 45 individual
test cases. There is no existing test to model after — this is the first one, so
the structural pattern for every future test in this repo is set here. Keep it
plain: `describe` per exported function, `it` per case, explicit imports, no
shared mutable state between tests, no snapshots.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0
- [ ] `ls packages/core/src/*.test.ts packages/core/src/email/*.test.ts` lists 6 files
- [ ] `pnpm --filter @workspace/core test` reports **at least 45 passing tests
      and 0 failing**
- [ ] `git diff --stat 57408de..HEAD -- packages/core/src/rotation.ts packages/core/src/spintax.ts packages/core/src/variables.ts packages/core/src/crypto.ts packages/core/src/email/quote.ts packages/core/src/email/transport.ts`
      shows **no changes** (no production source was modified)
- [ ] `git status --porcelain` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- Installing Vitest fails, or Vitest cannot resolve the TypeScript sources.
- `pnpm typecheck` fails in a way you cannot resolve by adding `.js` extensions
  to relative imports in your own test files.
- A test you wrote from this plan's specification **fails against the current
  implementation**. That means you found a bug. Do not fix the implementation
  and do not weaken the test to make it pass. Report the function, the input,
  the expected value from this plan, and the actual value. The likeliest
  candidates are the DST edge cases in `nextSendWindowStart` and
  `startOfDayInTimezone`, both of which carry code comments admitting they are
  approximations.
- You conclude a module needs refactoring to be testable. It does not — every
  function in scope is already pure.

## Maintenance notes

- Every future package that needs tests should copy the three-line
  `vitest.config.ts` and the `"test": "vitest run"` script. Turbo picks it up
  automatically once the script exists.
- `apps/web` will need `resolve.alias` for its `@/` prefix and a fixture
  database before its `lib/` modules can be tested. That is deliberately not
  done here.
- Reviewer should scrutinize: that no file under `packages/core/src/` other than
  the `*.test.ts` files appears in the diff, and that the timezone tests use
  fixed UTC instants rather than `new Date()`.
- Deferred out of this plan: tests for `csv.ts`, `imap.ts`, `dns.ts`, and
  anything in `apps/web`.
