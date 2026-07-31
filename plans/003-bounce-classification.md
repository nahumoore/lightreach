# Plan 003: Stop permanently burning leads on soft and policy-based SMTP rejections

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 57408de..HEAD -- apps/web/lib/scheduler.ts packages/core/src/email`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (misclassifying in the other direction means retrying sends to
  genuinely dead addresses, which hurts sender reputation)
- **Depends on**: plans/001-test-baseline.md (this plan's correctness rests
  entirely on its test table; without the runner it cannot be verified)
- **Category**: bug
- **Planned at**: commit `57408de`, 2026-07-20

## Why this matters

When an SMTP send fails, the scheduler asks `isHardBounce(err)` whether the
recipient address is permanently invalid. If it answers yes, three irreversible
things happen: the message is marked `failed`, **the lead is set to `bounced`,
and every remaining queued message for that lead is set to `skipped`** — the
whole sequence is cancelled.

The current implementation answers yes for **any** SMTP code in 550–554 except
552. That range is far too wide. Real-world examples that land in it and are
*not* invalid addresses:

- `554 5.7.1 Message rejected due to content` — a spam filter rejected this
  particular message. The mailbox is fine.
- `550 5.7.1 Service unavailable, client host blocked using Spamhaus` — your
  sending IP is on a blocklist. Every recipient at that provider is fine.
- `550 5.7.26 Unauthenticated email is not accepted from this domain` — your
  SPF/DKIM setup is broken. Every address is fine.
- `553 5.7.1 Sender address rejected` — a problem with *your* From address.

Each of these currently marks a good lead as permanently bounced and cancels
their follow-ups. For a cold-email tool, a temporary blocklisting or a
misconfigured DKIM record therefore silently destroys the campaign it happens
during — and the damage is not visible as an error, it looks like the leads were
bad.

The damage is also not undoable from the UI. `markLeadStatus` in
`apps/web/lib/inbox-poller.ts:213-215` treats `bounced` as terminal and refuses
to overwrite it, and the leads table has no "restore" action — the only path
back is the MCP `leads` update tool.

This plan makes the classifier read the **enhanced status code** (RFC 3463
`X.Y.Z`), which is the field that actually distinguishes "no such mailbox"
(`5.1.1`) from "your message was rejected as spam" (`5.7.1`), and makes the
3-digit fallback conservative: when in doubt, retry rather than burn the lead.

## Current state

### The classifier, today

`apps/web/lib/scheduler.ts:41-58`:

```ts
/**
 * A hard bounce means the recipient address itself is invalid and future
 * sends to it should stop. 552 (mailbox full/quota) is a transient condition
 * on an otherwise-valid address, not a permanent failure, so it's excluded.
 */
function isHardBounce(err: unknown): boolean {
  const code = (err as { responseCode?: number }).responseCode
  if (code !== undefined) {
    if (code === 552) return false
    return code >= 550 && code <= 554
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/\b552\b/.test(msg)) return false
  if (/\b55[0134]\b/.test(msg)) return true
  return /\b(user.*unknown|mailbox.*unavailable|no.*such.*user|address.*rejected|does not exist|invalid.*mailbox)\b/i.test(
    msg,
  )
}
```

Two defects beyond the range being too wide:

1. It never inspects `err.response`, which is where Nodemailer puts the full
   SMTP reply text — and therefore where the enhanced status code lives. It only
   reads the 3-digit `responseCode` and, as a fallback, `err.message`.
2. The regex fallback `/\b55[0134]\b/` matches those digits **anywhere** in the
   message string, including inside a quoted portion of the server's reply.

### The consequence, today

`apps/web/lib/scheduler.ts:534-553`:

```ts
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Lightreach] Failed to send message ${msg.msgId}:`, errMsg)

      if (isHardBounce(err)) {
        await db
          .update(messages)
          .set({ status: 'failed', error: errMsg })
          .where(eq(messages.id, msg.msgId))
        await db
          .update(leads)
          .set({ status: 'bounced' })
          .where(eq(leads.id, msg.leadId))
        await db
          .update(messages)
          .set({ status: 'skipped' })
          .where(and(eq(messages.leadId, msg.leadId), eq(messages.status, 'queued')))
        console.log(
          `[Lightreach] Hard bounce for lead ${msg.leadId} (message ${msg.msgId}) — lead marked bounced, future messages skipped`,
        )
      } else {
```

The `else` branch (lines 554-597) is the good path this plan routes more errors
into: it re-queues with exponential backoff up to `MAX_ATTEMPTS` (3), and
increments the connection's `consecutiveFailures`, disabling the mailbox after
`CONNECTION_ERROR_THRESHOLD` (3) consecutive failures.

**That existing soft-failure path is already correct and must not be modified.**
It is exactly what should happen for a blocklisting or a content rejection.

### Conventions to follow

- **`packages/core` uses `moduleResolution: "NodeNext"`**: relative imports in
  its TypeScript source need a `.js` extension. Source style is **double quotes
  with semicolons** — match `packages/core/src/email/quote.ts`.
- **`apps/web` source style is single quotes, no semicolons** — match
  `apps/web/lib/scheduler.ts`.
- Core modules are registered in the `"exports"` map of
  `packages/core/package.json`; existing entries include
  `"./email/quote": "./src/email/quote.ts"`.
- `packages/core/src/email/quote.ts` is the structural exemplar for a new pure
  module in this package: a file-level doc comment explaining the domain problem,
  exported constants for the pattern tables, then the exported functions.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | exit 0, all pass |
| Core tests only | `pnpm --filter @workspace/core test` | exit 0, all pass |
| Build | `pnpm build` | exit 0 |

No new dependency is needed for this plan.

## Scope

**In scope**:
- `packages/core/src/email/bounce.ts` (create — the classifier moves here so it
  can be tested without importing the scheduler, the database, or Next.js)
- `packages/core/src/email/bounce.test.ts` (create)
- `packages/core/package.json` (one new `exports` entry)
- `apps/web/lib/scheduler.ts` (delete the local `isHardBounce`, import the new
  one — **no other change to this file**)

**Out of scope** (do NOT touch):
- The `else` branch at `scheduler.ts:554-597` (retry/backoff and
  `consecutiveFailures` handling). It is correct; this plan only changes which
  errors reach it.
- `apps/web/lib/inbox-poller.ts` — DSN/bounce-notification handling arrives by a
  completely different route (parsing a bounce *email*, `handleBounce` at
  `inbox-poller.ts:233-258`) and is out of scope. Do not try to unify them.
- The terminal-status rule in `markLeadStatus`
  (`inbox-poller.ts:213-215`). Making `bounced` reversible is a separate
  feature, noted under Maintenance.
- Any change to `MAX_ATTEMPTS`, `CONNECTION_ERROR_THRESHOLD`, or
  `RETRY_BACKOFF_BASE_MS` in `scheduler.ts:27-30`.
- The database schema. No migration is needed.

## Git workflow

- Branch: `advisor/003-bounce-classification`
- Conventional Commits, e.g. `fix: classify smtp policy rejections as soft
  failures`. Recent repo example: `fix: unblock Docker build and migrations for
  fresh clones`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the classifier module

Create `packages/core/src/email/bounce.ts` exporting:

```ts
export interface SmtpErrorLike {
  responseCode?: number;
  response?: string;
  message?: string;
}

export function isHardBounce(err: unknown): boolean;
```

Accept `unknown` and duck-type the fields, exactly as the current
implementation does — the scheduler passes a raw caught error.

**The classification algorithm, in this order:**

1. **Gather the text to inspect.** Concatenate, when present:
   `err.response` (the full SMTP reply — Nodemailer sets this), then
   `err.message`. Search the combined string.

2. **Enhanced status code (RFC 3463) takes priority.** Look for the first match
   of `/\b([245])\.(\d{1,3})\.(\d{1,3})\b/` in the text.
   - Class `4` → **not** a hard bounce (transient by definition). Return false.
   - Class `2` → not a failure at all. Return false.
   - Class `5`, then switch on subject and detail:
     - `5.1.1`, `5.1.2`, `5.1.3`, `5.1.6`, `5.1.10` → **hard**. These are the
       codes that mean the destination address itself is bad.
     - `5.2.1` (mailbox disabled) → **hard**.
     - `5.2.2` (mailbox full / over quota) → **not hard**. Consistent with the
       existing 552 carve-out.
     - `5.7.*` (security and policy) → **not hard**. This is the single most
       important line in this plan: it covers spam rejections, blocklistings,
       and SPF/DKIM failures.
     - `5.4.*` (routing / network) → **not hard**.
     - `5.3.*` (mail system status, e.g. system full) → **not hard**.
     - anything else in class 5 → **not hard** (conservative default).

3. **No enhanced code found — fall back to the 3-digit reply code**, taken from
   `err.responseCode` if it is a number, otherwise from a
   `/(?:^|\s)([45]\d{2})(?:\s|-|$)/` match on the text. Note the anchoring: the
   digits must be at a word boundary adjacent to whitespace or a hyphen, so a
   `550` appearing inside quoted body text does not match.
   - `4xx` → **not hard**.
   - `551` (user not local), `553` (mailbox name not allowed) → **hard**.
   - `552` (quota) → **not hard**.
   - `554` (generic "transaction failed") → **not hard**. This is a change in
     behavior and is deliberate: `554` is what most providers return for content
     and reputation rejections.
   - `550` → **hard only if** the text also matches the recipient-specific
     phrasing regex below. A bare `550` is ambiguous.
   - any other code → **not hard**.

4. **Recipient-phrasing regex**, used for the `550` case above and as the final
   fallback when there is no usable code at all. Keep the existing phrases and
   add the common ones:

   ```
   /(user unknown|unknown user|no such user|no such mailbox|mailbox unavailable|mailbox not found|recipient (address )?rejected|recipient not found|does not exist|invalid (mailbox|recipient)|address (does not exist|not found)|unrouteable address|user not found)/i
   ```

   Note this regex intentionally **drops** the current `address.*rejected`
   pattern's ability to match `sender address rejected` — that phrase is about
   the *sender*, not the recipient, and matching it is one of the current bugs.
   Verify with the test table that `553 5.7.1 Sender address rejected` is
   classified soft.

5. If nothing matches, return **false**. Defaulting to soft means a genuinely
   dead address costs at most `MAX_ATTEMPTS` (3) retries before the message is
   marked `failed` anyway — a small, self-limiting cost. Defaulting to hard
   costs an entire lead relationship, permanently.

Document that reasoning in the file-level doc comment, and export the pattern
tables as named constants so the tests can reference them.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Register the export

Add to the `"exports"` map in `packages/core/package.json`, next to
`"./email/quote"`:

```json
"./email/bounce": "./src/email/bounce.ts"
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Test the classifier against a table of real SMTP replies

Create `packages/core/src/email/bounce.test.ts`, following the structure from
plan 001 (explicit vitest imports, relative import with `.js` extension).

Drive it from a table, asserting `isHardBounce(...) === expected` for each row.
Construct the error objects two ways — once as
`{ responseCode: N, response: "<text>" }` (the Nodemailer shape) and once as
`new Error("<text>")` (the fallback shape) — to cover both branches.

**Must classify as HARD (`true`):**

| Reply text | Why |
|---|---|
| `550 5.1.1 <a@b.com>: Recipient address rejected: User unknown in virtual mailbox table` | canonical dead address |
| `550 5.1.1 The email account that you tried to reach does not exist` | Gmail's wording |
| `551 5.1.6 User not local; please try <forward-path>` | |
| `553 5.1.3 Requested action not taken: mailbox name not allowed` | bad syntax |
| `550 5.2.1 The email account that you tried to reach is disabled` | |
| `550 5.1.10 Recipient address has null MX` | |
| `550 No such user here` (no enhanced code) | phrasing fallback |

**Must classify as SOFT (`false`) — these are the regressions this plan fixes:**

| Reply text | Why |
|---|---|
| `554 5.7.1 Message rejected due to content` | content filter, mailbox is fine |
| `550 5.7.1 Service unavailable; Client host [1.2.3.4] blocked using Spamhaus` | IP blocklisted |
| `550 5.7.26 Unauthenticated email is not accepted from this domain` | your SPF/DKIM |
| `553 5.7.1 Sender address rejected: not owned by user` | about the sender |
| `552 5.2.2 The email account that you tried to reach is over quota` | quota |
| `450 4.2.1 The user you are trying to contact is receiving mail too quickly` | greylisting |
| `421 4.7.0 Try again later, closing connection` | rate limit |
| `554 Transaction failed` (no enhanced code) | ambiguous 554 |
| `550 Requested action not taken` (no enhanced code, no phrasing) | ambiguous 550 |
| `Error: connect ETIMEDOUT 1.2.3.4:587` | network error, no SMTP code |
| `Error: Invalid login: 535 Authentication failed` | our credentials, not the recipient |

**Structural cases:**

- `isHardBounce(undefined)`, `isHardBounce(null)`, `isHardBounce({})` → `false`,
  and none of them throw.
- An error whose *body text* quotes a code — e.g.
  `new Error("554 5.7.1 rejected: your message said 'call 550 now'")` → `false`.
  This is the anchoring regression guard.
- When `responseCode` and the enhanced code in `response` disagree — e.g.
  `{ responseCode: 550, response: "550 5.7.1 blocked" }` — the **enhanced code
  wins**, so the result is `false`.

**Verify**: `pnpm --filter @workspace/core test` → all pass, exit 0, with at
least 25 new cases in `bounce.test.ts`. Every row above must have an assertion.

### Step 4: Switch the scheduler to the shared classifier

In `apps/web/lib/scheduler.ts`:

1. Delete the local `isHardBounce` function and its doc comment (lines 41-58).
2. Add the import alongside the other `@workspace/core` imports near the top
   (the file already imports from `@workspace/core/crypto`,
   `@workspace/core/email/transport`, `@workspace/core/rotation`,
   `@workspace/core/spintax`, `@workspace/core/variables`):

   ```ts
   import { isHardBounce } from '@workspace/core/email/bounce'
   ```

3. Change nothing else. The call site at line 538 (`if (isHardBounce(err))`)
   stays exactly as it is.

**Verify**:
- `grep -n "function isHardBounce" apps/web/lib/scheduler.ts` → **no matches**
- `grep -n "isHardBounce" apps/web/lib/scheduler.ts` → exactly 2 matches (the
  import and the call)
- `pnpm typecheck` → exit 0

### Step 5: Improve the log line for soft failures

The existing hard-bounce branch logs why it acted. The soft branch does not,
which will make the new behavior hard to observe in production. In the `else`
branch, immediately after the `attempts` variable is computed
(`scheduler.ts:556`), add one `console.log` recording that the failure was
treated as transient, including `msg.msgId`, the attempt number, and
`MAX_ATTEMPTS`.

Use `console.log` with the `[Lightreach]` prefix to match every other log line
in this file. (The repo has no structured logger; matching local convention
beats introducing one here.)

**Verify**: `pnpm lint` → exit 0. `pnpm typecheck` → exit 0.

### Step 6: Full verification

- `pnpm typecheck` → exit 0
- `pnpm lint` → exit 0
- `pnpm test` → exit 0, all tests from plans 001 and 002 still pass
- `pnpm build` → exit 0

## Test plan

All in `packages/core/src/email/bounce.test.ts`, per Step 3: at least 25 cases
driven from the table above, covering both error shapes, both code paths
(enhanced and 3-digit), and the malformed-input guards. Model the file structure
on the tests created by plan 001.

There are no tests for `scheduler.ts` itself, and this plan does not add any —
extracting the classifier into a pure, testable module is precisely how the
behavior gets covered without standing up a database fixture.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm build` exits 0
- [ ] `packages/core/src/email/bounce.ts` exists and exports `isHardBounce`
- [ ] `grep -n '"./email/bounce"' packages/core/package.json` → one match
- [ ] `grep -c "isHardBounce" apps/web/lib/scheduler.ts` → `2`
- [ ] `grep -n "function isHardBounce" apps/web/lib/scheduler.ts` → no matches
- [ ] `pnpm --filter @workspace/core test` reports at least 25 new passing tests
      from `bounce.test.ts`, 0 failing
- [ ] Specifically confirmed by a passing assertion:
      `554 5.7.1 Message rejected due to content` → `false`, and
      `550 5.1.1 ... User unknown` → `true`
- [ ] `git diff 57408de..HEAD -- apps/web/lib/scheduler.ts` touches only the
      import block, the deleted `isHardBounce`, and the one added log line
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- Plan 001 has not landed (no `pnpm test` script exists). This plan's value is
  entirely in its test table; shipping the logic change unverified is worse than
  not shipping it.
- You find yourself modifying the `else` (soft-failure) branch beyond the single
  added log line in Step 5, or touching the lead/message status updates in the
  hard-bounce branch.
- Any test from plan 001 or 002 starts failing.
- You conclude the classifier needs the database, the message row, or the
  connection record to decide. It does not — it takes only the caught error.
- You discover that Nodemailer does not populate `err.response` for SMTP
  rejections in the installed version. Report this; the fallback path still
  works, but the plan's premise should be recorded as partially unverified.

## Maintenance notes

- **The default is now "soft".** A new SMTP code or provider phrasing that
  genuinely means "dead address" will be retried three times before the message
  is marked `failed`, and the lead will stay active. That is the intended
  trade-off. If a provider's dead-address wording shows up in production logs,
  add it to the phrasing regex in `bounce.ts` **with a test row**, not to the
  3-digit code list.
- A reviewer should scrutinize the enhanced-code table in Step 1 against the
  test rows, and confirm nothing in `scheduler.ts` changed except the import,
  the deletion, and the log line.
- Interacts with `inbox-poller.ts:handleBounce`, which marks leads bounced from
  DSN *emails*. That path uses the provider's own bounce notification, is more
  reliable, and is unchanged. If it is ever made stricter, keep the two paths'
  definitions of "hard" aligned.
- **Deferred out of this plan, and worth doing next**: `bounced` and
  `unsubscribed` are terminal statuses with no way back from the dashboard UI
  (`inbox-poller.ts:213-215` refuses to overwrite them; the leads table offers
  no restore action). Even with a correct classifier, misclassification is
  inevitable — a "restore lead to contacted" server action would turn permanent
  data loss into an inconvenience. Not included here to keep this change
  reviewable.
