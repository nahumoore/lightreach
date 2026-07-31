# Plan 006: Replace the per-row write loop in `saveFilteredKeywords` with batched updates

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 57408de..HEAD -- apps/web/app/\(dashboard\)/inbox/actions.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `57408de`, 2026-07-20

## Why this matters

Saving the inbox filter keywords re-evaluates every stored inbound email against
the new keyword list. It does this by loading every row and then issuing **one
`UPDATE` statement per row** in a JavaScript loop, each one `await`ed in
sequence.

On a mailbox with a few thousand received emails that is a few thousand
sequential round-trips to SQLite inside a single server action. The action
blocks for as long as it takes, and because the app runs a single Node process
that also hosts the scheduler and inbox poller (`apps/web/instrumentation.ts`),
that work competes with the send loop.

There is a second, quieter problem: the loop is not transactional. If it throws
halfway — or the process restarts mid-loop — some rows carry the new
classification and the rest carry the old one, with nothing recording that the
operation was incomplete. The next save would fix it, but only if someone
happens to do one.

This is the smallest item on the list and the fix is mechanical. It is worth
doing because the cost grows with every email the operator ever receives.

## Current state

`apps/web/app/(dashboard)/inbox/actions.ts:26-57`, in full:

```ts
export async function saveFilteredKeywords(keywords: string) {
  await db
    .insert(appSettings)
    .values({ key: 'filter_keywords', value: keywords })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: keywords, updatedAt: new Date() },
    })

  // Re-flag existing rows based on the new keyword list
  const kws = keywords
    .split(/[\n,]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)

  if (kws.length > 0) {
    const allEmails = await db
      .select({ id: inboundEmails.id, subject: inboundEmails.subject, bodyText: inboundEmails.bodyText })
      .from(inboundEmails)

    for (const row of allEmails) {
      const haystack = `${row.subject} ${row.bodyText ?? ''}`.toLowerCase()
      const isFiltered = kws.some((kw) => haystack.includes(kw))
      await db.update(inboundEmails).set({ isFiltered }).where(eq(inboundEmails.id, row.id))
    }
  } else {
    // No keywords → clear all filtered flags
    await db.update(inboundEmails).set({ isFiltered: false })
  }

  revalidatePath('/inbox')
}
```

The `else` branch is already a single bulk statement and is fine as-is.

The same matching rule is implemented independently in the poller,
`apps/web/lib/inbox-poller.ts:54-57`:

```ts
function isFilteredMatch(subject: string, bodyText: string | null, keywords: string[]): boolean {
  const haystack = `${subject} ${bodyText ?? ''}`.toLowerCase()
  return keywords.some((kw) => haystack.includes(kw))
}
```

Note it is byte-identical logic. **The matching semantics must not change** —
if the two ever disagree, an email would be classified one way on arrival and
another way after a keyword save, which is a bug that would be very hard to
spot.

### Relevant technical facts

- The database driver is **better-sqlite3**, which is **synchronous**. See
  `packages/db/src/client.ts:1-15`. The `await`s in the code above work because
  Drizzle's query builders are thenable, not because the driver is async.
- Consequently `db.transaction(cb)` on this driver takes a **synchronous**
  callback. You cannot `await` inside it. Statements inside a transaction must
  be executed with `.run()` (e.g. `tx.update(x).set(y).where(z).run()`).
- SQLite has a limit on the number of bound parameters per statement. Modern
  builds default to 32766, older ones to 999. An `inArray(...)` over every
  matching row id would bind one parameter per id, so **the id lists must be
  chunked**. Use a chunk size of **500** — comfortably under even the old limit,
  and still a ~500× reduction in statement count.

### Conventions to follow

- `apps/web` source style: **single quotes, no semicolons**. Match the
  surrounding file.
- Server actions live in `app/<feature>/actions.ts` with `'use server'` at the
  top and call `revalidatePath` after writing — see `CLAUDE.md` under "Server
  Actions pattern".
- Drizzle operators are imported from `drizzle-orm` at the top of the file; the
  file currently imports `{ eq, and, sql }`. You will need to add `inArray`
  and/or `notInArray`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | exit 0, all pass |
| Build | `pnpm build` | exit 0 |
| Dev server | `pnpm dev` | serves on http://localhost:3000 |

## Scope

**In scope**:
- `apps/web/app/(dashboard)/inbox/actions.ts` — the body of
  `saveFilteredKeywords` only

**Out of scope** (do NOT touch):
- `apps/web/lib/inbox-poller.ts` — including `isFilteredMatch`. Do **not**
  refactor the two implementations into a shared helper as part of this plan.
  That is a reasonable idea, but it changes a file on the send/poll path for a
  perf fix, and it would make this diff impossible to review for behavior
  preservation. Noted under Maintenance.
- The `else` branch (no keywords → clear all flags). Already a single statement.
- The `appSettings` upsert at the top of the function.
- Every other export in `inbox/actions.ts` — `markRead`, `markUnread`,
  `replyToEmail`, `categorizeEmail`, `triggerFetch`, `getOutboundMessages`.
- The database schema. No migration is needed.

## Git workflow

- Branch: `advisor/006-batch-keyword-reflag`
- Conventional Commits, e.g. `perf: batch inbox keyword re-flag updates`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Compute both id sets in one pass

Replace the `for` loop's classification work with a single pass that partitions
the loaded rows into two arrays of ids — `matchedIds` and `unmatchedIds` — using
**exactly** the existing expression:

```ts
const haystack = `${row.subject} ${row.bodyText ?? ''}`.toLowerCase()
const isFiltered = kws.some((kw) => haystack.includes(kw))
```

Do not rewrite this into a regex, a `Set`, or a SQL `LIKE`. Preserving it
character for character is what guarantees this change is behavior-neutral and
keeps it aligned with `isFilteredMatch` in the poller.

Keep the existing `select` of `id`, `subject`, and `bodyText` unchanged.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Write both sets in chunked bulk updates

Add a module-private helper above `saveFilteredKeywords`:

```ts
/** SQLite binds one parameter per id, so large id lists must be split. */
const UPDATE_CHUNK_SIZE = 500

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}
```

Then replace the per-row loop with two chunked loops:

```ts
for (const ids of chunk(matchedIds, UPDATE_CHUNK_SIZE)) {
  await db.update(inboundEmails).set({ isFiltered: true }).where(inArray(inboundEmails.id, ids))
}
for (const ids of chunk(unmatchedIds, UPDATE_CHUNK_SIZE)) {
  await db.update(inboundEmails).set({ isFiltered: false }).where(inArray(inboundEmails.id, ids))
}
```

Add `inArray` to the `drizzle-orm` import at the top of the file.

Skip the loop entirely when an array is empty — `inArray` with an empty list is
a footgun in several ORMs and there is no reason to issue the statement.

**Verify**:
- `grep -n "db.update(inboundEmails)" "apps/web/app/(dashboard)/inbox/actions.ts"`
  → 3 matches (two chunked updates plus the untouched `else` branch)
- `grep -n "eq(inboundEmails.id, row.id)" "apps/web/app/(dashboard)/inbox/actions.ts"`
  → **no matches** (the per-row update is gone)
- `pnpm typecheck` → exit 0

### Step 3: Make the re-flag atomic

Wrap the two chunked loops in a single transaction so a partial re-flag can
never be left behind.

Because the driver is synchronous (see "Current state"), the callback must be
synchronous and each statement must end in `.run()`:

```ts
db.transaction((tx) => {
  for (const ids of chunk(matchedIds, UPDATE_CHUNK_SIZE)) {
    tx.update(inboundEmails).set({ isFiltered: true }).where(inArray(inboundEmails.id, ids)).run()
  }
  for (const ids of chunk(unmatchedIds, UPDATE_CHUNK_SIZE)) {
    tx.update(inboundEmails).set({ isFiltered: false }).where(inArray(inboundEmails.id, ids)).run()
  }
})
```

Note there is **no `await`** on `db.transaction` here and no `async` on the
callback — adding either silently breaks the transaction's atomicity guarantee
on this driver, because the transaction commits when the synchronous callback
returns.

**If the transaction shape does not typecheck cleanly in two attempts, drop
Step 3, keep the awaited chunked updates from Step 2, and say so in your
report.** The batching is the main win; atomicity is a bonus. Do not spend the
plan's budget fighting driver types.

**Verify**: `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

### Step 4: Verify behavior against a running app

Start the dev server in a tmux session (per the global convention for
long-lived processes):

```bash
tmux new-session -d -s lightreach-006 'pnpm dev'
```

In the browser, on the `/inbox` page:

1. Note which emails currently show as filtered (the Filtered/warmup tab).
2. Open the keyword settings, save a keyword you know appears in at least one
   email's subject or body. Confirm exactly the expected emails move to the
   filtered set.
3. Save an additional keyword. Confirm the set grows correctly and previously
   matched emails stay matched.
4. Remove a keyword. Confirm emails that matched only that keyword move back to
   unfiltered — **this is the case the old code got right and a naive "only set
   true" rewrite would break.**
5. Clear all keywords. Confirm every email becomes unfiltered (the untouched
   `else` branch).

Kill the session when finished: `tmux kill-session -t lightreach-006`.

**Verify**: all five checks behave exactly as they did before the change. If you
have no inbound emails in the local database, say so in your report and mark
this step as not exercised rather than claiming it passed.

### Step 5: Full verification

- `pnpm typecheck` → exit 0
- `pnpm lint` → exit 0
- `pnpm test` → exit 0 (all tests from earlier plans still pass)
- `pnpm build` → exit 0
- `git status --porcelain` → only `apps/web/app/(dashboard)/inbox/actions.ts`
  is modified

## Test plan

No automated test is added. `saveFilteredKeywords` touches the database
directly, and `apps/web` has no test harness or database fixtures — plan 001
deliberately scoped the runner to `packages/core`. Building fixture
infrastructure for a P3 perf fix is not a good trade.

The verification is therefore Step 4's manual check, and the guarantee that
matters is Step 1's requirement that the matching expression is copied
unchanged. A reviewer should confirm that by reading the diff.

If a future plan adds a test harness for `apps/web`, the cases worth writing
are: keyword added → matching rows flagged; keyword removed → previously
matching rows unflagged; empty keyword list → all rows unflagged; and a row
count above `UPDATE_CHUNK_SIZE` to exercise chunking.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm build` exits 0
- [ ] `grep -n "eq(inboundEmails.id, row.id)" "apps/web/app/(dashboard)/inbox/actions.ts"`
      → no matches
- [ ] The matching expression `\`${row.subject} ${row.bodyText ?? ''}\`.toLowerCase()`
      appears unchanged in the diff
- [ ] `git diff 57408de..HEAD -- apps/web/lib/inbox-poller.ts` shows no changes
- [ ] `git status --porcelain` lists only `inbox/actions.ts`
- [ ] Step 4 either passed all five checks or is reported as not exercised, with
      the reason
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `inbox/actions.ts:26-57` doesn't match the "Current state" excerpt.
- You conclude the matching logic should be rewritten (regex, SQL `LIKE`, a
  shared helper with the poller). All three are out of scope; the value of this
  change rests on it being provably behavior-neutral.
- The transaction in Step 3 does not typecheck after two attempts — fall back as
  instructed and report, rather than restructuring the action.
- Step 4 shows any difference in which emails are flagged compared to before the
  change.

## Maintenance notes

- **The keyword-matching rule now exists in two places**:
  `saveFilteredKeywords` in `inbox/actions.ts` and `isFilteredMatch` in
  `inbox-poller.ts:54-57`. They must stay identical — an email must classify the
  same way whether it is evaluated on arrival or during a re-flag. Extracting a
  shared helper into `packages/core` is the right long-term fix and was
  deliberately left out of this plan to keep the diff provably behavior-neutral;
  it is a good standalone follow-up, ideally with tests.
- `UPDATE_CHUNK_SIZE` of 500 is conservative. It exists because of SQLite's bound
  parameter limit, not for memory reasons — do not raise it without checking the
  compiled limit of the bundled better-sqlite3.
- This action still loads every row of `inbound_emails` into memory to classify
  them. That is acceptable at the scale of a single-user inbox, but if the table
  ever grows past hundreds of thousands of rows, the classification itself should
  move into SQL. Doing that requires escaping `%` and `_` in user-supplied
  keywords before interpolating them into a `LIKE` pattern.
- A reviewer should check the removal-of-a-keyword case specifically: any rewrite
  that only ever sets `isFiltered: true` looks correct in testing until someone
  removes a keyword.
