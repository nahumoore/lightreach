# Plan 004: Put a single-user password gate in front of the entire application

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 57408de..HEAD -- apps/web README.md .env.docker.example docker-compose.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (a mistake here locks the operator out of their own instance, or
  leaves a hole that reads as closed)
- **Depends on**: none (independent of 001–003; can proceed in parallel)
- **Category**: security
- **Planned at**: commit `57408de`, 2026-07-20

## Why this matters

There is no authentication anywhere in this application. No `proxy.ts`, no
`middleware.ts`, no session, no password. Every page and all 32 server actions
are reachable by anyone who can open the port.

`docker-compose.yml` publishes the app on port 3000 over plain HTTP and `README`
/ `CLAUDE.md` invite the operator to run it on a VPS. Anyone who finds that host
can read every lead, read every received email, send mail from the operator's
mailboxes, change the sending configuration, and mint an MCP API token. The SMTP
passwords themselves are encrypted at rest — but the application will happily
decrypt and *use* them for anyone who asks, which is the part that matters.

This is listed in `CLAUDE.md` under "Next Milestones" as
`[ ] Auth (single-user password or API key gate)`, so it is a known gap rather
than an oversight. It is on this list because it is also the multiplier on every
other vulnerability: plan 002's stored XSS is a browser-session compromise
precisely because there is no session boundary to cross.

## Current state

- **There is no `apps/web/proxy.ts` and no `apps/web/middleware.ts`.** Confirm
  with `ls apps/web/proxy.ts apps/web/middleware.ts` → both "No such file".
- `apps/web/app/page.tsx` redirects `/` to `/dashboard`:

  ```tsx
  import { redirect } from "next/navigation"

  // Root → redirect to dashboard
  export default function RootPage() {
    redirect("/dashboard")
  }
  ```

- All application pages live under the route group
  `apps/web/app/(dashboard)/` — `dashboard`, `connections`, `leads`,
  `sequences`, `campaigns`, `emails`, `inbox`, `settings`, `mcp`, `templates`.
  A route group in parentheses does **not** appear in the URL, so these are
  served at `/dashboard`, `/connections`, and so on.
- **32 server actions** are exported across seven files:

  | File | Exported actions |
  |---|---|
  | `apps/web/app/(dashboard)/campaigns/actions.ts` | 5 |
  | `apps/web/app/(dashboard)/connections/actions.ts` | 7 |
  | `apps/web/app/(dashboard)/inbox/actions.ts` | 7 |
  | `apps/web/app/(dashboard)/leads/actions.ts` | 6 |
  | `apps/web/app/(dashboard)/mcp/actions.ts` | 3 |
  | `apps/web/app/(dashboard)/sequences/actions.ts` | 3 |
  | `apps/web/app/(dashboard)/settings/actions.ts` | 1 |

  Each file begins with `'use server'` and exports `async function`s, e.g.
  `apps/web/app/(dashboard)/settings/actions.ts:1-17`:

  ```ts
  'use server'
  import { db, appSettings } from '@workspace/db'
  import { DEFAULT_UNSUBSCRIBE_TEXT } from '@workspace/core/email/transport'
  import { revalidatePath } from 'next/cache'

  const MAX_FOOTER_LENGTH = 2000

  export async function saveUnsubscribeFooter(text: string) {
    if (typeof text !== 'string' || text.length > MAX_FOOTER_LENGTH) {
      throw new Error('Invalid opt-out footer')
    }
  ```

- `apps/web/app/api/mcp/route.ts` **already has its own authentication** — a
  bearer token check via `requireBearer` from `apps/web/lib/mcp/auth.ts`, which
  compares with `timingSafeEqual`. That route must be **excluded** from the
  cookie gate; MCP clients send a bearer token, not a browser cookie.

  `apps/web/lib/mcp/auth.ts:22-38` is also the **exemplar for constant-time
  comparison in this repo** — match its shape:

  ```ts
  export async function requireBearer(request: Request): Promise<boolean> {
    const token = await getMcpToken()
    if (!token) return false

    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return false

    const provided = authHeader.slice(7)
    try {
      const a = Buffer.from(token, 'utf8')
      const b = Buffer.from(provided, 'utf8')
      if (a.length !== b.length) return false
      return timingSafeEqual(a, b)
    } catch {
      return false
    }
  }
  ```

  Note the pattern: length-check first, `timingSafeEqual` second, `catch`
  returns false. Fail closed.

- `APP_ENCRYPTION_KEY` is an existing required env var (64 hex chars), read by
  `packages/core/src/crypto.ts:21-30`. This plan reuses it as the HMAC key for
  signing session cookies — do not introduce a second secret.

### ⚠️ Next.js 16 breaking change you MUST know before writing any code

**In Next.js 16, Middleware was renamed to Proxy.** The file is
`apps/web/proxy.ts` (not `middleware.ts`) and it exports a function named
`proxy` (not `middleware`). From the bundled docs at
`apps/web/node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`:

> Starting with Next.js 16, Middleware is now called Proxy to better reflect its
> purpose. The functionality remains the same.

Two more facts from
`apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:219`:

> Proxy defaults to using the Node.js runtime. The `runtime` config option is
> not available in Proxy files. Setting the `runtime` config option in Proxy
> will throw an error.

So: **you get the Node.js runtime for free, and you must not add a
`export const runtime = ...` line** — it throws. Node's `crypto` module is
available in `proxy.ts`; you do not need WebCrypto.

`CLAUDE.md` opens with a standing instruction for this repo: *"This is NOT the
Next.js you know. Next.js 16 has breaking changes. Before writing any app code
read the relevant guide in `apps/web/node_modules/next/dist/docs/`."* Read both
files named above before Step 2.

## Design (decided — do not redesign)

**Password source: the `LIGHTREACH_PASSWORD` environment variable.** No database
table, no migration, no hashing at rest, no first-run setup wizard. This matches
how `APP_ENCRYPTION_KEY` already works, suits a single-user self-hosted app, and
removes an entire class of things a bootstrap flow gets wrong.

**Fail closed**: if `LIGHTREACH_PASSWORD` is unset or empty, login always fails
and every route redirects to `/login`, which displays a message telling the
operator to set the variable. An unconfigured instance is inaccessible, not
open.

**Session: a stateless signed cookie.** Value is `<expiresAtMs>.<hmac>` where
the HMAC is SHA-256 over the `expiresAtMs` string, keyed with
`APP_ENCRYPTION_KEY`. No session store, no DB read in the request path.

**Cookie flags**: `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`,
`maxAge` 30 days. **`secure` must be `false` when the request is plain HTTP** —
`docker-compose.yml` ships without TLS on purpose (the README tells operators to
front it with their own proxy), and a `secure` cookie would silently never be
stored, producing an infinite redirect loop. Set
`secure: process.env.NODE_ENV === 'production' && <request is https>`; derive the
second condition from the `x-forwarded-proto` header, defaulting to false.

**Two layers**: the proxy redirects unauthenticated browser requests (fast,
central), and a `requireSession()` guard at the top of every server action
enforces it at the data boundary. The Next docs are explicit that proxy alone
is not sufficient — see
`apps/web/node_modules/next/dist/docs/01-app/02-guides/authentication.md:1119`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | exit 0 (if plan 001 landed) |
| Build | `pnpm build` | exit 0 |
| Dev server | `pnpm dev` | serves on http://localhost:3000 |

No new dependency is needed for this plan.

## Scope

**In scope**:
- `apps/web/proxy.ts` (create)
- `apps/web/lib/auth.ts` (create — session sign/verify + `requireSession`)
- `apps/web/app/login/page.tsx` (create)
- `apps/web/app/login/login-form.tsx` (create, `'use client'`)
- `apps/web/app/login/actions.ts` (create — `logIn`, `logOut`)
- The seven `actions.ts` files listed in "Current state" (add one guard line to
  each of the 32 exported actions)
- `apps/web/components/app-header.tsx` (add a log-out control)
- `apps/web/instrumentation.ts` (warn at boot when `LIGHTREACH_PASSWORD` is unset)
- `.env.docker.example` and `README.md` and `CLAUDE.md` (document the new
  variable; tick the auth milestone in `CLAUDE.md`)

**Out of scope** (do NOT touch):
- `apps/web/app/api/mcp/route.ts` and `apps/web/lib/mcp/auth.ts` — the MCP route
  has its own bearer authentication and must be **excluded** from the cookie
  gate, not converted to it. Breaking it breaks every configured MCP client.
- `packages/core/src/crypto.ts` — reuse `APP_ENCRYPTION_KEY` by reading the env
  var directly in `apps/web/lib/auth.ts`. Do not add session logic to the
  crypto module; `encrypt`/`decrypt` there are for SMTP secrets at rest.
- Any multi-user concept: no users table, no roles, no registration, no password
  reset. This is a single-user gate.
- The scheduler and inbox poller. They run in-process from
  `instrumentation.ts`, not via HTTP, and are unaffected.
- Adding TLS. `docker-compose.yml` and `Caddyfile` already document the
  reverse-proxy story; leave them.

## Git workflow

- Branch: `advisor/004-auth-gate`
- Conventional Commits, e.g. `feat: add single-user password gate`. Recent repo
  example: `feat: make the campaign opt-out footer editable in Settings`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the Next.js 16 docs

Read, in full:
- `apps/web/node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`
- `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`

Confirm from the second file that the exported function is named `proxy`, that
the `config.matcher` export works as described, and that you must not set a
`runtime` export.

**Verify**: state in your working notes the exact export signature you will use.

### Step 2: Write the session module

Create `apps/web/lib/auth.ts`. It is server-only (it reads `process.env` and
uses `node:crypto`); never import it from a `'use client'` file.

Export:

- `const SESSION_COOKIE = 'lightreach_session'`
- `function createSessionValue(now: number): string` — computes
  `expiresAt = now + THIRTY_DAYS_MS`, returns `` `${expiresAt}.${hmac}` `` where
  `hmac = createHmac('sha256', key).update(String(expiresAt)).digest('hex')` and
  `key` is `Buffer.from(process.env.APP_ENCRYPTION_KEY, 'hex')`.
- `function verifySessionValue(value: string | undefined, now: number): boolean`
  — returns false for missing/malformed input; splits on the last `.`; returns
  false if `expiresAt` is not a finite number or is `<= now`; recomputes the
  HMAC and compares with `timingSafeEqual` guarded by a length check, following
  the pattern in `apps/web/lib/mcp/auth.ts:29-37`. Wrap in `try/catch` and
  return false on any throw.
- `function isPasswordConfigured(): boolean` — true when
  `process.env.LIGHTREACH_PASSWORD` is a non-empty string.
- `function checkPassword(provided: string): boolean` — returns false when not
  configured; otherwise a constant-time comparison against
  `LIGHTREACH_PASSWORD`, same shape as `requireBearer`.
- `async function requireSession(): Promise<void>` — reads the cookie via
  `cookies()` from `next/headers` (**`await cookies()` — it is async in Next
  15+**), calls `verifySessionValue`, and `throw new Error('Unauthorized')` when
  invalid. This is the guard used by server actions.

If `APP_ENCRYPTION_KEY` is missing or not 64 hex characters, throw with the same
message style as `packages/core/src/crypto.ts:24-27`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Write the proxy

Create `apps/web/proxy.ts`:

```ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySessionValue } from '@/lib/auth'

export function proxy(request: NextRequest) {
  // ...
}

export const config = {
  matcher: [/* see below */],
}
```

Behavior:
- Read `request.cookies.get(SESSION_COOKIE)?.value` and pass it to
  `verifySessionValue(value, Date.now())`.
- If valid → `NextResponse.next()`.
- If invalid → `NextResponse.redirect(new URL('/login', request.url))`.
- If the request path already starts with `/login` → always allow through,
  otherwise the redirect loops.

The `config.matcher` must exclude, at minimum: `/login`, `/api/mcp`,
`/_next/static`, `/_next/image`, and `/favicon.ico`. Use a negative-lookahead
matcher of the form documented in the proxy API reference you read in Step 1 —
copy the shape from the docs rather than inventing a regex.

**Critical**: the matcher must still cover `/` and every `(dashboard)` route.
Remember that the route-group parentheses are not part of the URL: the paths to
protect are `/dashboard`, `/connections`, `/leads`, `/sequences`, `/campaigns`,
`/emails`, `/inbox`, `/settings`, `/mcp`, `/templates`.

Note that `/mcp` (the settings page for managing the MCP token) is a normal
dashboard page and **must be protected**; `/api/mcp` (the JSON-RPC endpoint) is
the one that must be excluded. Do not confuse them — an exclusion pattern of
`/mcp` would open the token-management UI.

**Verify**: `pnpm build` → exit 0, and the build output lists the proxy.

### Step 4: Build the login route

Create three files under `apps/web/app/login/`:

`actions.ts` (`'use server'`):
- `logIn(password: string): Promise<{ ok: boolean; error?: string }>` — if
  `!isPasswordConfigured()` return
  `{ ok: false, error: 'No password configured. Set LIGHTREACH_PASSWORD and restart.' }`;
  if `!checkPassword(password)` return `{ ok: false, error: 'Incorrect password' }`;
  otherwise set the session cookie via `(await cookies()).set(...)` with the
  flags from the Design section and return `{ ok: true }`.
- `logOut(): Promise<void>` — delete the cookie, then `redirect('/login')`.

**Never log the submitted password, and never include it in an error message or
a thrown error.** The repo rule is in `CLAUDE.md` under Security Rules.

`page.tsx` — a server component rendering `<LoginForm />` centered on the page.
If `!isPasswordConfigured()`, render the "set LIGHTREACH_PASSWORD" message
instead of the form.

`login-form.tsx` (`'use client'`) — a password `Input`, a submit `Button`, and
error display. Use the existing shared components (`@workspace/ui/components/input`,
`.../button`, `.../card`, `.../label`) and `toast` from `sonner`, matching the
form conventions in `apps/web/app/(dashboard)/settings/unsubscribe-footer-form.tsx`.
Use `useTransition` for the pending state, as the other forms in this repo do.
On `{ ok: true }`, navigate to `/dashboard` with `useRouter().push` followed by
`router.refresh()`.

Styling: **semantic tokens only** (`bg-background`, `text-foreground`,
`text-muted-foreground`, `border-border`). `CLAUDE.md` forbids hard-coded hex or
hsl values.

**Verify**: `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

### Step 5: Guard all 32 server actions

In each of the seven files listed in "Current state", add:

```ts
import { requireSession } from '@/lib/auth'
```

and make `await requireSession()` the **first statement** of every exported
`async function` — all 32 of them.

Example, for `apps/web/app/(dashboard)/settings/actions.ts`:

```ts
export async function saveUnsubscribeFooter(text: string) {
  await requireSession()

  if (typeof text !== 'string' || text.length > MAX_FOOTER_LENGTH) {
    throw new Error('Invalid opt-out footer')
  }
```

Do not change any other logic in these files. Do not add the guard to
non-exported helper functions (e.g. `resolveThreadLead` and
`findOrCreateLeadFromInbound` in `inbox/actions.ts` are module-private — leave
them alone).

**Verify**:
- `grep -c "await requireSession()" "apps/web/app/(dashboard)"/*/actions.ts`
  → the per-file counts must be exactly: campaigns 5, connections 7, inbox 7,
  leads 6, mcp 3, sequences 3, settings 1.
- `grep -c "^export async function" "apps/web/app/(dashboard)"/*/actions.ts`
  → the same seven numbers. **The two lists must match file for file.**
- `pnpm typecheck` → exit 0.

### Step 6: Add a log-out control

Add a log-out button or dropdown item to `apps/web/components/app-header.tsx`
that calls the `logOut` action. Match the existing header's component and icon
conventions (`@tabler/icons-react`; `IconLogout` is the natural choice).

**Verify**: `pnpm typecheck` → exit 0; `pnpm lint` → exit 0.

### Step 7: Warn at boot when no password is configured

In `apps/web/instrumentation.ts`, inside `register()` after the
`NEXT_RUNTIME !== "nodejs"` early return, log a clear warning when
`process.env.LIGHTREACH_PASSWORD` is unset or empty — stating that the
application will refuse all logins until it is set. Use `console.warn` with the
`[Lightreach]` prefix, matching the log style in `apps/web/lib/scheduler.ts`.

**Never log the value itself**, only whether it is present.

**Verify**: `pnpm typecheck` → exit 0.

### Step 8: Document the variable

- `.env.docker.example`: add a `LIGHTREACH_PASSWORD=` line with a comment
  explaining it gates the web UI and that the app rejects all logins until it is
  set. Follow the file's existing comment style.
- `README.md`: document it wherever `APP_ENCRYPTION_KEY` is documented.
- `CLAUDE.md`: add it to the "Environment Variables" section, and change the
  milestone line `- [ ] Auth (single-user password or API key gate)` to `- [x]`.

**Verify**: `grep -rn "LIGHTREACH_PASSWORD" .env.docker.example README.md CLAUDE.md`
→ at least one match in each.

### Step 9: Manual verification against a running server

This is the step that catches a broken matcher or a cookie that never persists.
Start the dev server with a password set, in a `tmux` session (per the global
convention for long-lived processes):

```bash
tmux new-session -d -s lightreach-auth 'LIGHTREACH_PASSWORD=test-pw-do-not-ship pnpm dev'
```

Wait for it to be listening, then check each of these with `curl`:

| Check | Command | Expected |
|---|---|---|
| Dashboard redirects | `curl -si localhost:3000/dashboard \| head -1` | `HTTP/1.1 307` (or 302) |
| Root redirects | `curl -si localhost:3000/ \| head -1` | a redirect, ultimately to `/login` |
| Settings redirects | `curl -si localhost:3000/settings \| head -1` | a redirect |
| MCP page redirects | `curl -si localhost:3000/mcp \| head -1` | a redirect |
| Login is reachable | `curl -s -o /dev/null -w '%{http_code}' localhost:3000/login` | `200` |
| MCP API still 401s on its own terms | `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/api/mcp` | `401` — **not** a redirect. A `307` here means the matcher is wrongly capturing `/api/mcp`. |
| Static assets load | open `/login` in a browser | CSS applies; no unstyled page |

Then in a browser: submit the wrong password → an error is shown and no cookie
is set. Submit `test-pw-do-not-ship` → redirected to `/dashboard`, and a
subsequent reload stays on `/dashboard`. Click log out → back at `/login`, and
`/dashboard` redirects again.

Finally, kill the server and restart it **without** the variable:

```bash
tmux kill-session -t lightreach-auth
tmux new-session -d -s lightreach-auth 'pnpm dev'
```

`/login` must render the "set LIGHTREACH_PASSWORD" message, submitting anything
must fail, and `/dashboard` must still redirect. **Fail closed, not open.**

Kill the session when finished: `tmux kill-session -t lightreach-auth`.

**Verify**: every row in the table above matches, and both fail-closed checks
pass.

## Test plan

The session primitives are pure and should be unit-tested if plan 001 has
landed. If `pnpm test` exists, create `apps/web/lib/auth.test.ts`; if plan 001
has not landed, skip this section and note it in your report rather than
building a test harness here.

Cases for `verifySessionValue`, using a fixed `now` and a fixed
`APP_ENCRYPTION_KEY` of `"0".repeat(64)` set in a `beforeAll` (**never a real
key**):
- a value from `createSessionValue(now)` verifies at `now + 1000` → `true`
- the same value at `now + THIRTY_DAYS_MS + 1` → `false` (expiry enforced)
- a value with a valid timestamp but a tampered HMAC → `false`
- a value with a bumped timestamp and the original HMAC → `false` (this is the
  forgery case: extending your own session must not work)
- `undefined`, `''`, `'garbage'`, `'123'`, `'abc.def'` → `false`, no throw

For `checkPassword`: returns false when `LIGHTREACH_PASSWORD` is unset; false on
a wrong password; false on a password that is a prefix of the correct one; true
on an exact match.

**Verify**: `pnpm test` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm build` exits 0
- [ ] `pnpm test` exits 0 (or documented as skipped because plan 001 has not landed)
- [ ] `apps/web/proxy.ts` exists, exports a function named `proxy`, and contains
      **no** `export const runtime` line
- [ ] `ls apps/web/middleware.ts` → no such file (Next 16 uses `proxy.ts`)
- [ ] Per-file `grep -c "await requireSession()"` counts equal the per-file
      `grep -c "^export async function"` counts for all seven `actions.ts` files
      (5, 7, 7, 6, 3, 3, 1 — total 32)
- [ ] `grep -rn "requireSession\|SESSION_COOKIE" apps/web/lib/mcp/` → no matches
      (MCP auth untouched)
- [ ] `git diff 57408de..HEAD -- apps/web/app/api/mcp/route.ts apps/web/lib/mcp/auth.ts`
      shows no changes
- [ ] Every row of the Step 9 verification table passes, including
      `POST /api/mcp` returning `401` rather than a redirect
- [ ] With `LIGHTREACH_PASSWORD` unset, the app is inaccessible (not open)
- [ ] `grep -rn "LIGHTREACH_PASSWORD" .env.docker.example README.md CLAUDE.md`
      → at least one match in each
- [ ] No password or key value appears anywhere in the diff or in any log line
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `ls apps/web/proxy.ts apps/web/middleware.ts` shows either file already exists
  — someone has started this work.
- The build errors with a message about `runtime` not being configurable in a
  proxy file. Remove the `runtime` export; if it persists, stop.
- `POST /api/mcp` returns a redirect instead of `401` and you cannot fix the
  matcher in two attempts. A broken MCP endpoint is a regression; report the
  matcher you tried.
- After logging in successfully you are redirected back to `/login` (a loop).
  The usual cause is the `secure` cookie flag being set on a plain-HTTP request
  — check the Design section before changing anything else.
- You conclude the design needs a users table, a password-reset flow, a
  migration, or an OAuth provider. It does not. This is a single-user gate.
- Any existing test from plans 001–003 starts failing.

## Maintenance notes

- **Rotating the password requires restarting the process**, since it is read
  from the environment. That is the accepted trade-off for having no user table.
  Changing `APP_ENCRYPTION_KEY` invalidates every existing session (the HMAC key
  changes) — that is correct behavior, but it means a key rotation logs the
  operator out, and it also makes every stored SMTP password undecryptable, so
  the key must not be rotated casually.
- Sessions are stateless. There is **no way to revoke a single issued cookie**
  before its 30-day expiry short of changing `APP_ENCRYPTION_KEY`. If revocation
  is ever needed, add a `session_epoch` value in `app_settings`, include it in
  the signed payload, and bump it to invalidate everything.
- **Any new server action must start with `await requireSession()`.** A reviewer
  should check that the two grep counts in the Done criteria still match after
  any PR that adds an action. This is the kind of invariant worth an ESLint rule
  later.
- **Any new route handler under `apps/web/app/api/` is NOT covered by the
  server-action guard** and must either be inside the proxy matcher or carry its
  own check, as `/api/mcp` does.
- The proxy is an optimistic check. The Next 16 docs
  (`.../02-guides/authentication.md:1119`) are explicit that it should not be
  the only line of defense; the per-action guard from Step 5 is what satisfies
  that.
- Deferred out of this plan: rate limiting on the login action, which would
  matter more if this were internet-facing without a reverse proxy. Brute-force
  resistance currently rests on the operator choosing a strong password.
