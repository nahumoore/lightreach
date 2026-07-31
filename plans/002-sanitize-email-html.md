# Plan 002: Sanitize email HTML on the server before it is injected into the dashboard DOM

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 57408de..HEAD -- packages/core/src/email apps/web/app/\(dashboard\)/inbox apps/web/app/\(dashboard\)/emails`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (a too-aggressive allowlist visibly breaks email rendering)
- **Depends on**: plans/001-test-baseline.md (the test harness — this plan adds
  tests to it)
- **Category**: security
- **Planned at**: commit `57408de`, 2026-07-20

## Why this matters

The inbox renders the HTML body of received emails with
`dangerouslySetInnerHTML` and **no sanitization anywhere in the path**. Every
byte of that HTML is chosen by whoever sent the email. Anyone who replies to one
of your cold emails — or who simply emails a connected mailbox — can include
`<img src=x onerror="...">` or `<svg onload="...">` and have that JavaScript
execute in the application's origin the moment you open the message.

That origin currently has no authentication (see plan 004) and hosts server
actions that decrypt SMTP passwords, send mail from your mailboxes, and read
every lead in the database. So this is not a cosmetic defacement bug: it is
remote code execution in the operator's browser session, triggered by an action
as ordinary as reading a reply.

A secondary benefit: email HTML routinely carries `<style>` blocks with generic
selectors, which today leak out and restyle the dashboard around the message.
Stripping them fixes that too.

## Current state

There are exactly two `dangerouslySetInnerHTML` sinks that render email content,
both fed from **server components**. That is what makes this fixable in one
place per page rather than in the React tree.

### Sink 1 — inbound email bodies (the attacker-controlled one)

`apps/web/app/(dashboard)/inbox/inbox-view.tsx:302-331` (this file is
`'use client'`):

```tsx
function InboundBody({
  bodyText,
  bodyHtml,
}: {
  bodyText: string | null
  bodyHtml: string | null
}) {
  const [showQuote, setShowQuote] = useState(false)
  const { reply, quoted, isHtml } = useMemo(
    () => splitQuotedReply(bodyText, bodyHtml),
    [bodyText, bodyHtml],
  )
  const hasReply = reply.trim().length > 0

  return (
    <>
      {isHtml ? (
        hasReply ? (
          <div
            className="prose prose-sm dark:prose-invert max-w-none text-sm"
            dangerouslySetInnerHTML={{ __html: reply }}
          />
```

and again at `inbox-view.tsx:347-350` for the quoted portion.

`splitQuotedReply` (`packages/core/src/email/quote.ts`) only slices the string
at a marker index — it does no filtering whatsoever.

The data reaches that component from the server component
`apps/web/app/(dashboard)/inbox/page.tsx:60-71`:

```tsx
  const rows: InboundRow[] = rawEmails.map((r) => ({
    ...r,
    receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
    repliedAt: r.repliedAt ? r.repliedAt.toISOString() : null,
  }))

  return (
    <InboxView
      emails={rows}
      filteredKeywords={keywordRow[0]?.value ?? ''}
    />
  )
```

`bodyHtml` is selected raw at `page.tsx:36` and passed straight through.

### Sink 2 — outbound message preview

`apps/web/app/(dashboard)/emails/emails-view.tsx:252-260`:

```tsx
          <div className="px-6 py-4">
            {email.body ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: email.body }}
              />
```

Its data comes from `apps/web/app/(dashboard)/emails/page.tsx`, which builds
each row in a single function with one return site, `toRow` at
`emails/page.tsx:122-137`:

```tsx
  return {
    id: r.id,
    status: r.status,
    stepPosition: r.stepPosition,
    subject,
    body,
    error: r.error,
```

`body` here is the operator's own sequence template with lead values
substituted, so it is lower risk than sink 1 — but the lead values come from
uploaded CSVs, so it is not trusted either, and it costs one line to cover.

### Conventions to follow

- **`packages/core` uses `moduleResolution: "NodeNext"`**: relative imports in
  its TypeScript source need a `.js` extension (`import { x } from "./y.js"`).
  `packages/core` source style is **double quotes with semicolons** — match
  `packages/core/src/email/quote.ts`.
- **`apps/web` source style is single quotes, no semicolons** — match
  `apps/web/app/(dashboard)/inbox/page.tsx`.
- **Server-only modules must never be imported from a `'use client'` file.**
  This is stated in `CLAUDE.md` under "Database access" and applies here:
  `inbox-view.tsx` and `emails-view.tsx` both start with `'use client'`. All
  sanitization in this plan happens in `page.tsx` files, which are server
  components. Do not import the sanitizer into a view component.
- Each core module gets an entry in the `"exports"` map of
  `packages/core/package.json`. Existing entries, for reference:

  ```json
  "./email/transport": "./src/email/transport.ts",
  "./email/imap": "./src/email/imap.ts",
  "./email/dns": "./src/email/dns.ts",
  "./email/quote": "./src/email/quote.ts"
  ```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Add core dep | `pnpm add --filter @workspace/core sanitize-html` | exit 0 |
| Add core types | `pnpm add -D --filter @workspace/core @types/sanitize-html` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | exit 0, all pass |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**:
- `packages/core/src/email/sanitize.ts` (create)
- `packages/core/src/email/sanitize.test.ts` (create)
- `packages/core/package.json` (add dependency + one `exports` entry)
- `apps/web/app/(dashboard)/inbox/page.tsx` (sanitize `bodyHtml` in the row map)
- `apps/web/app/(dashboard)/emails/page.tsx` (sanitize `body` in `toRow`)
- `pnpm-lock.yaml` (result of the install)

**Out of scope** (do NOT touch):
- `apps/web/app/(dashboard)/inbox/inbox-view.tsx` and
  `apps/web/app/(dashboard)/emails/emails-view.tsx` — **leave the
  `dangerouslySetInnerHTML` calls exactly as they are.** They become safe
  because their input is now sanitized upstream. Importing a Node-only
  sanitizer into these `'use client'` files would break the client build.
- `packages/core/src/email/quote.ts` — splitting is orthogonal to sanitizing
  and its tests (from plan 001) must keep passing unchanged.
- `apps/web/lib/inbox-poller.ts` — do **not** sanitize at write time. Storing
  the original HTML is correct: it is evidence, `bodyText`-based keyword
  filtering reads from a different column, and a future change to the allowlist
  must be able to re-render old mail. Sanitize on the way out, not on the way in.
- Any change to `next.config.ts`. `sanitize-html` is pure JavaScript with no
  native or DOM dependency, so it needs no bundler configuration. **If you find
  yourself editing `next.config.ts`, you have chosen the wrong library — STOP.**

## Git workflow

- Branch: `advisor/002-sanitize-email-html`
- Conventional Commits, e.g. `fix: sanitize inbound email html before rendering`.
  Recent repo examples: `refactor: centralize opt-out footer resolution in one
  server helper`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Install `sanitize-html`

```bash
pnpm add --filter @workspace/core sanitize-html
pnpm add -D --filter @workspace/core @types/sanitize-html
```

Use **`sanitize-html`** specifically. Do not substitute `dompurify` or
`isomorphic-dompurify`: those need a DOM implementation (jsdom) on the server,
which adds a heavy native-adjacent dependency and has to be taught to Next's
standalone output tracing. `sanitize-html` parses with `htmlparser2` and runs in
plain Node with no configuration.

**Verify**: `pnpm --filter @workspace/core exec node -e "require('sanitize-html'); console.log('ok')"`
→ prints `ok`.

### Step 2: Write the sanitizer module

Create `packages/core/src/email/sanitize.ts`. It must export a single function
`sanitizeEmailHtml(html: string | null | undefined): string`, returning `""` for
nullish input.

Requirements for the configuration you pass to `sanitize-html`:

- **Allowed tags** — enough that real email renders: `p`, `br`, `div`, `span`,
  `a`, `b`, `strong`, `i`, `em`, `u`, `s`, `sub`, `sup`, `ul`, `ol`, `li`,
  `blockquote`, `pre`, `code`, `hr`, `h1`–`h6`, `table`, `thead`, `tbody`,
  `tfoot`, `tr`, `td`, `th`, `caption`, `img`, `figure`, `figcaption`.
- **Explicitly NOT allowed**: `script`, `style`, `iframe`, `frame`, `frameset`,
  `object`, `embed`, `applet`, `form`, `input`, `button`, `textarea`, `select`,
  `link`, `meta`, `base`, `svg`, `math`. `sanitize-html` drops anything not on
  the allowlist, so this is achieved by omission — but assert it in tests.
- **`nonTextTags`**: include `"style"` and `"script"` so their *contents* are
  discarded too, not just their tags. Without this the CSS or JS source text is
  rendered as visible page text.
- **Allowed attributes** — allowlist only, which is what removes every `on*`
  event handler:
  - `a`: `href`, `name`, `target`, `title`
  - `img`: `src`, `alt`, `title`, `width`, `height`
  - `td`/`th`/`table`/`tr`: `colspan`, `rowspan`, `align`, `valign`
  - all tags (`"*"`): `dir`, `lang`
  - Do **not** allow `style`, `class`, or `id` on any tag. Inline `style` is an
    injection surface and the app's own `prose` classes handle presentation.
- **`allowedSchemes`**: `["http", "https", "mailto", "tel"]`. This is what stops
  `javascript:` and `data:` URLs.
- **`allowedSchemesByTag`**: for `img`, `["http", "https", "cid"]` — no `data:`,
  because `data:image/svg+xml` can carry script.
- **`transformTags`**: rewrite every `<a>` to add `rel="noopener noreferrer
  nofollow"` and `target="_blank"`. A link in a stranger's email must not get a
  handle on the dashboard window.

Write a file-level doc comment in the style of the neighbouring
`packages/core/src/email/quote.ts` explaining that this is the single
sanitization boundary for untrusted email HTML and that it is server-only.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Export the module

Add to the `"exports"` map in `packages/core/package.json`, next to the existing
`"./email/quote"` entry:

```json
"./email/sanitize": "./src/email/sanitize.ts"
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Test the sanitizer

Create `packages/core/src/email/sanitize.test.ts` following the structure
established in plan 001 (explicit `import { describe, it, expect } from
"vitest"`, relative import with a `.js` extension:
`import { sanitizeEmailHtml } from "./sanitize.js"`).

Each of these must assert on the **output string**, not just that the call
didn't throw:

- `sanitizeEmailHtml(null)` and `sanitizeEmailHtml(undefined)` return `""`.
- `<script>alert(1)</script>` — output contains neither `<script` nor `alert(1)`.
- `<img src=x onerror="alert(1)">` — output has no `onerror` substring.
- `<svg onload="alert(1)"></svg>` — output has no `onload` and no `<svg`.
- `<a href="javascript:alert(1)">x</a>` — output has no `javascript:`.
- `<iframe src="https://evil.test"></iframe>` — output has no `<iframe`.
- `<style>body{display:none}</style>` — output contains neither `<style` nor
  `display:none` (this is the `nonTextTags` check).
- `<div onclick="alert(1)">hi</div>` — output has no `onclick`, and still
  contains `hi`.
- `<a href="https://example.com">x</a>` — output **keeps** the href and gains
  `rel="noopener noreferrer nofollow"`.
- **Benign email markup survives**: an input of
  `<p>Hi <strong>there</strong></p><ul><li>one</li></ul><table><tr><td>c</td></tr></table>`
  round-trips with all of `<p>`, `<strong>`, `<ul>`, `<li>`, `<table>`, `<td>`
  and the text content intact. This is the regression guard against an
  over-aggressive allowlist.
- `<p style="color:red">x</p>` — the `style` attribute is gone, the `<p>` and
  its text remain.
- Nested/malformed input such as `<scr<script>ipt>alert(1)</script>` does not
  produce a live `<script` tag in the output.

**Verify**: `pnpm --filter @workspace/core test` → all pass, including the tests
from plan 001, exit 0.

### Step 5: Sanitize at the inbox page boundary

In `apps/web/app/(dashboard)/inbox/page.tsx`, import the helper:

```ts
import { sanitizeEmailHtml } from '@workspace/core/email/sanitize'
```

and change the row map (currently at lines 60-64) so `bodyHtml` is sanitized.
The `InboundRow` type keeps `bodyHtml: string | null`, so preserve the null when
there is no HTML body rather than turning it into an empty string — the client
component branches on `bodyHtml` being truthy to choose the HTML or plain-text
rendering path, and an empty string must behave the same as null:

```tsx
  const rows: InboundRow[] = rawEmails.map((r) => ({
    ...r,
    bodyHtml: r.bodyHtml ? sanitizeEmailHtml(r.bodyHtml) || null : null,
    receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
    repliedAt: r.repliedAt ? r.repliedAt.toISOString() : null,
  }))
```

Place `bodyHtml` **after** the `...r` spread so it overrides the raw value.

**Verify**: `pnpm typecheck` → exit 0. Then
`grep -n "sanitizeEmailHtml" "apps/web/app/(dashboard)/inbox/page.tsx"` → two
matches (the import and the call).

### Step 6: Sanitize at the emails page boundary

In `apps/web/app/(dashboard)/emails/page.tsx`, import the same helper and apply
it to `body` in the single return of `toRow` (currently line 122-137):

```tsx
  return {
    id: r.id,
    status: r.status,
    stepPosition: r.stepPosition,
    subject,
    body: body != null ? sanitizeEmailHtml(body) : null,
    error: r.error,
```

Leave the rest of `toRow` unchanged, including the `appendUnsubscribeFooter`
call above it — sanitizing after the footer is appended is correct and keeps the
footer's `<p style="...">` wrapper honest. **Note:** the footer's inline `style`
attribute WILL be stripped by the sanitizer, so the preview will show the
opt-out line unstyled. That is expected and acceptable — the real outbound email
built in `packages/core/src/email/transport.ts` is not sanitized and keeps its
styling. Do not attempt to special-case the footer.

**Verify**: `pnpm typecheck` → exit 0.

### Step 7: Full verification

Run in order:
- `pnpm typecheck` → exit 0
- `pnpm lint` → exit 0
- `pnpm test` → exit 0
- `pnpm build` → exit 0. **This is the step that catches an accidental import of
  the server-only sanitizer into a `'use client'` file.**
- `grep -rn "dangerouslySetInnerHTML" "apps/web/app"` → still exactly 3 matches
  (`inbox-view.tsx` ×2, `emails-view.tsx` ×1). You are not removing them; you
  are making their inputs safe.

## Test plan

Covered in Step 4: one new file,
`packages/core/src/email/sanitize.test.ts`, with at least 12 cases split between
"the attack is neutralized" and "legitimate markup survives". Model the file
structure on the tests created by plan 001. The single most important case is
the benign-markup round-trip — a sanitizer that breaks ordinary email will get
reverted, which is worse than one that is slightly permissive.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 with at least 12 new passing tests in `sanitize.test.ts`
- [ ] `pnpm build` exits 0
- [ ] `packages/core/src/email/sanitize.ts` exists and exports `sanitizeEmailHtml`
- [ ] `grep -n '"./email/sanitize"' packages/core/package.json` → one match
- [ ] `grep -rn "sanitizeEmailHtml" "apps/web/app"` → exactly 4 matches (import +
      call in each of the two `page.tsx` files)
- [ ] `grep -rln "sanitizeEmailHtml" "apps/web/app" | xargs grep -l "use client"`
      → **no output** (the sanitizer is never imported into a client component)
- [ ] `git diff --stat 57408de..HEAD -- "apps/web/app/(dashboard)/inbox/inbox-view.tsx" "apps/web/app/(dashboard)/emails/emails-view.tsx"`
      shows no changes
- [ ] `git status --porcelain` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts.
- `pnpm build` fails with a message about a Node module (`fs`, `stream`,
  `htmlparser2`) not resolving in the browser bundle. That means the sanitizer
  reached a client component — revert the import and report which file pulled it
  in.
- You conclude the fix requires editing `inbox-view.tsx`, `emails-view.tsx`, or
  `next.config.ts`. All three are out of scope; if the fix seems to need them,
  the approach has diverged from this plan.
- The benign-markup round-trip test in Step 4 fails, i.e. the allowlist strips
  ordinary email formatting. Report which tag or attribute was lost rather than
  widening the allowlist to include `style`, `script`, or `iframe`.
- You discover a third `dangerouslySetInnerHTML` sink that renders email content
  and is fed from a client-side data source rather than a server component.

## Maintenance notes

- **`sanitizeEmailHtml` is now the single trust boundary for untrusted HTML.**
  Any future surface that renders email bodies — a thread view, an export, a
  print stylesheet — must call it. A reviewer seeing a new
  `dangerouslySetInnerHTML` in a PR should ask where the sanitization happens.
- Original HTML is intentionally preserved in the `inbound_emails.bodyHtml`
  column. If the allowlist is later widened or narrowed, previously stored mail
  re-renders under the new rules automatically. Do not "migrate" the column.
- The opt-out footer preview in the Emails view renders without its inline
  styling as a consequence of Step 6. If that ever matters, the fix is to build
  the preview footer from a CSS class rather than to loosen the sanitizer.
- Deferred out of this plan: rendering email bodies inside a sandboxed
  `<iframe srcdoc>` , which would additionally isolate layout and CSS and remove
  the reliance on an allowlist being complete. That is the stronger long-term
  design; it was deferred because it changes the visual layout of the inbox
  sheet and needs height-measurement work.
