# Lightreach — Dev Handbook

> ⚠️ **This is NOT the Next.js you know.**
> Next.js 16 has breaking changes. Before writing any app code read the relevant guide
> in `apps/web/node_modules/next/dist/docs/`. Heed deprecation notices.

---

## What is Lightreach?

Lightreach is a **free, self-hosted, lightweight cold-email outreach platform** — a slim
alternative to Instantly / Smartlead / lemlist. It is single-user, requires no external
services beyond your own SMTP mailboxes, and runs from a single `pnpm dev` command.

### Feature Map

| Section | What it does |
|---|---|
| **Dashboard** | Activity overview and send analytics. |
| **Connections** | Add SMTP mailboxes (Gmail, Outlook, custom). Test, pause, track daily limits. Optional IMAP config per mailbox. |
| **Inbox / Emails** | Poll received mail across all IMAP mailboxes. Automatic reply and warmup detection. |
| **Leads** | Upload CSVs with column-mapping wizard. Manage lists + individual leads. |
| **Sequences** | Multi-step email sequences with configurable `delayDays` between steps. Write with `{spintax\|options}` and `{{variable\|fallback}}` placeholders. Live preview. |
| **Campaigns** | Pair a sequence with a lead list, assign mailboxes to rotate across, set schedule. |
| **Scheduling** | Send-window (time of day), days of week, daily cap, min/max delay jitter between sends. |
| **Suppressions** | Global do-not-email list of addresses and whole domains. Filled automatically by unsubscribe links, STOP replies and hard bounces; add or CSV-import entries by hand. Checked before every send, across all lists and campaigns. |
| **Settings** | App-level defaults, encryption key and `APP_URL` status, sending behavior. |

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) |
| UI library | shadcn/ui (radix-rhea style, Tabler icons) |
| Styling | Tailwind CSS v4 (CSS-first config) |
| Component pkg | `@workspace/ui` — shared across all apps |
| Data | SQLite via Drizzle ORM + drizzle-kit |
| Email (send) | Nodemailer (user-provided SMTP credentials) |
| Email (receive) | imapflow + mailparser (IMAP polling, reply/warmup detection) |
| Monorepo | pnpm workspaces + Turborepo |
| Language | TypeScript 5 strict |

---

## Repo Layout

```
lightreach/
├── apps/
│   └── web/              # Next.js 16 app (the main UI + API)
├── packages/
│   ├── core/             # @workspace/core — pure business logic
│   │   ├── src/spintax.ts      # {a|b|c} expansion
│   │   ├── src/variables.ts    # {{firstName|fallback}} rendering
│   │   ├── src/crypto.ts       # AES-256-GCM encrypt/decrypt for SMTP secrets
│   │   ├── src/csv.ts          # CSV parsing + header-mapping helpers
│   │   ├── src/rotation.ts     # round-robin mailbox rotation
│   │   ├── src/email/transport.ts  # nodemailer transport builder + sendMail
│   │   ├── src/email/imap.ts       # imapflow IMAP polling + reply detection
│   │   └── src/email/bounce.ts     # hard/soft bounce classifier (DSN status codes + text)
│   ├── db/               # @workspace/db — Drizzle schema + client
│   │   ├── src/schema.ts
│   │   ├── src/client.ts
│   │   └── drizzle.config.ts
│   ├── ui/               # @workspace/ui — shadcn components + global CSS
│   ├── eslint-config/
│   └── typescript-config/
```

---

## Commands

```bash
# Development
pnpm dev          # run all apps in dev mode (turbo)
pnpm build        # production build
pnpm lint         # lint all workspaces
pnpm typecheck    # type-check all workspaces
pnpm format       # prettier all workspaces

# Database (run from repo root)
pnpm db:generate  # drizzle-kit generate — regenerate SQL migrations from schema.ts
pnpm db:migrate   # drizzle-kit migrate — apply migrations to data.db
pnpm db:studio    # open Drizzle Studio to browse data

# Adding shadcn components (always run from repo root)
pnpm dlx shadcn@latest add <component> -c apps/web
# → places the component in packages/ui/src/components/
```

---

## Code Conventions

### Imports
```ts
import { Button } from "@workspace/ui/components/button";   // UI components
import { db }     from "@workspace/db";                      // database client
import { expandSpintax } from "@workspace/core/spintax";    // core utilities
```

### Mutations → Server Actions
Prefer React Server Actions (`'use server'`) for all DB writes.
Define actions in `apps/web/app/<feature>/actions.ts`.

### Database access
Only import `@workspace/db` from **server** code (Server Components, Route Handlers,
Server Actions, `instrumentation.ts`). Never import it from `'use client'` files.

### Server Actions pattern
```ts
// app/connections/actions.ts
'use server'
import { db } from '@workspace/db'
import { connections } from '@workspace/db/schema'
import { revalidatePath } from 'next/cache'

export async function createConnection(data: NewConnection) {
  await db.insert(connections).values(data)
  revalidatePath('/connections')
}
```

---

## Theme & Styling

**Dark-first, blue primary.** The app defaults to dark mode.

- Use **semantic tokens only** (`bg-background`, `text-foreground`, `text-primary`,
  `border-border`, …). **Never hard-code hex or hsl values.**
- Primary blue lives in `--primary` (oklch). The dark-mode value is the showcase.
- All tokens are defined in `packages/ui/src/styles/globals.css`.
- Toggle theme with the `d` key (or the header toggle button).

---

## Security Rules

- **SMTP passwords are encrypted at rest** using AES-256-GCM before being stored in
  SQLite. Use `encrypt()`/`decrypt()` from `@workspace/core/crypto`.
- `APP_ENCRYPTION_KEY` is a required env var (32-byte hex string). The app should
  warn on startup if it is missing.
- **Never** log decrypted credentials or return `smtpPassEncrypted` to the client.
- Server Actions that write data must always be called from authenticated context
  (auth to be added in a future milestone).

---

## Environment Variables

Copy `.env.example` to `.env.local` before running:

```bash
# .env.local
APP_ENCRYPTION_KEY=  # 64 hex chars (32 bytes) — generate with: openssl rand -hex 32
DATABASE_URL=file:./data.db
APP_URL=             # optional, public base URL, e.g. https://outreach.example.com
```

`APP_URL` is used for the unsubscribe link in each email's `List-Unsubscribe` header
(see [Unsubscribe & Suppression](#unsubscribe--suppression)). Leave it unset to send a
mailto-only header.

---

## Deploy with Docker

The repo root ships a multi-stage `Dockerfile` (Next.js `output: "standalone"`) and a
`docker-compose.yml` for running Lightreach as an isolated, persistent instance on a VPS.

```bash
cp .env.docker.example .env
# generate a key and paste it into .env as APP_ENCRYPTION_KEY
openssl rand -hex 32

docker compose build
docker compose up -d
```

- `migrate` runs once (applies pending drizzle migrations), then `web` starts and serves
  on port `3000`.
- SQLite (`data.db` + WAL sidecars) persists in the `lightreach-data` named volume, mounted
  at `/data` — `docker compose down` (without `-v`) keeps your data.
- The container must run as a **single, long-lived Node process**: the in-process
  scheduler and inbox poller (`instrumentation.ts`) tick on `setInterval` inside that
  process, so do not scale `web` to multiple replicas or run it on a serverless platform.
- No TLS is configured by default — `docker-compose.yml` exposes plain HTTP on `3000` for
  you to front with your own reverse proxy. An optional `caddy` service (commented out in
  `docker-compose.yml`, config in `Caddyfile`) gives automatic Let's Encrypt HTTPS if the
  VPS doesn't already have a proxy — set your domain in `Caddyfile` and uncomment the
  service + `caddy-data`/`caddy-config` volumes.
- To pick up schema changes after a `git pull`, re-run `docker compose build && docker
  compose up -d` — the `migrate` service re-runs automatically before `web` restarts.

## Data Model (overview)

| Table | Purpose |
|---|---|
| `connections` | SMTP/IMAP mailboxes: host, port, auth, daily limit |
| `lists` | Named lead lists |
| `leads` | Individual contacts linked to a list |
| `sequences` | Multi-step email sequences (replaced `templates`) |
| `sequence_steps` | Individual steps: subject, body, delayDays |
| `campaigns` | Pair sequence + list + mailboxes + schedule |
| `campaign_connections` | Many-to-many: campaign ↔ connection (rotation set) |
| `messages` | Per-lead send queue + delivery log |
| `inbound_emails` | Received mail fetched via IMAP (replies, warmup) |
| `app_settings` | Key-value store for app-level preferences |
| `suppressions` | Global do-not-email list: `kind` (`email` \| `domain`), lowercased `value`, `reason`, optional `leadId`/`messageId` of what triggered it. Unique on `(kind, value)` |

See `packages/db/src/schema.ts` for full column definitions.

---

## In-Process Scheduler & Inbox Poller

`apps/web/instrumentation.ts` boots two background jobs on the Node.js runtime.
Both are **Node-only** — they will not run in Edge or serverless environments. For
production use, run the app as a persistent Node process (`pnpm build && pnpm start`),
not on a serverless platform that spins down between requests.

**Scheduler loop** (`lib/scheduler.ts`):
1. Find `messages` with `status = 'queued'` and `scheduledAt <= now`
   (before sending, a message is skipped if its lead is already replied/bounced/unsubscribed
   or its address or domain is in `suppressions`)
2. Pick the next active mailbox via `rotation.pickNext(campaignId)`
3. Respect send window (time of day + days of week)
4. Respect per-connection `dailyLimit` and per-campaign `dailyCap`
5. Apply `minDelaySeconds`/`maxDelaySeconds` jitter between sends
6. Call `transport.sendMail(connection, message)` (with `List-Unsubscribe` headers) → update `messages.status`

**Inbox poller** (`lib/inbox-poller.ts`):
Periodically fetches new mail via IMAP across all active connections with IMAP configured,
stores them in `inbound_emails`, and marks any matching outbound `messages` as replied.
Bounce notifications are classified with `@workspace/core/email/bounce` (see
[Bounce handling](#bounce-handling)).

---

## Unsubscribe & Suppression

The `suppressions` table is the single source of truth for "never email this address".
It is keyed by address (or whole domain), not by lead row, so a bounce or opt-out applies
to the same address in every list.

**What adds an entry:** an unsubscribe link or one-click request, a `STOP` reply, a hard
IMAP bounce (via `markLeadStatus` in the poller), a hard SMTP bounce in the scheduler, or
a manual add / CSV import on the Suppressions page (or the MCP tools).

**What checks it:** the scheduler, at send time (`isSuppressed` in `lib/suppression.ts`).
The message becomes `skipped` with error `Suppressed`, and the lead's other queued
messages are skipped too. Because it is checked at send time, entries added after a
campaign launched still apply.

**Unsubscribe links:** every campaign email (not manual replies or test emails) carries a
`List-Unsubscribe` header. The body keeps the plain "reply STOP" line on purpose; body
links hurt deliverability for cold mail.

- `APP_URL` set: header holds `<APP_URL>/api/unsubscribe/<token>` and a mailto
  fallback. `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) is added only
  when `APP_URL` is `https`.
- `APP_URL` unset: mailto only, to the sending mailbox with subject `unsubscribe`. The
  inbox poller treats that like a STOP reply, so the mailbox needs IMAP enabled.
- The token is `encrypt()` of `{email, messageRowId}`. It works after the campaign is
  deleted. **Changing `APP_ENCRYPTION_KEY` invalidates every link already sent.**
- `GET /api/unsubscribe/<token>` only shows a confirm page; `POST` performs the opt-out
  (idempotent). A bad token returns 404 and changes nothing.
- `docker-compose.yml` has a second Traefik router for `/api/unsubscribe` without basic
  auth (rate limit kept), because recipients cannot log in.

### Bounce handling

`classifyBounce` (`packages/core/src/email/bounce.ts`) reads the DSN `Action`, `Status`
and `Diagnostic-Code` (or the SMTP reply) and returns one of three outcomes:

| Outcome | Meaning | Examples | Lead | Suppression |
|---|---|---|---|---|
| `hard` | The address is dead | `5.1.x`, `5.2.1`, "user unknown" | bounced | yes (`bounced`) |
| `block` | Permanent rejection, not proof the address is dead | `5.7.x` policy/spam, `5.1.7`/`5.1.8` (sender address), any other unrecognised 5xx | bounced | no |
| `soft` | Temporary | `4.x.x`, `Action: delayed`, `5.2.2` / 552 mailbox full | unchanged | no |

Status codes decide first; diagnostic text only breaks ties when there is no usable code.

- **IMAP bounce emails** follow the table. A "Delivery Status Notification (Delay)" is `soft`
  and leaves the lead active.
- **SMTP errors at send time** only count as a bounce when the server rejected the
  recipient (`RCPT TO`, reply 550-554). A `hard` or `block` there never counts toward the
  mailbox's `consecutiveFailures`. Failures at `MAIL FROM`, `DATA`, auth or the connection
  (e.g. "550 5.4.5 Daily user sending limit exceeded") are the mailbox's problem: they never
  change the lead or suppress anything and use the normal retry / failure-count path.
  A 4xx or mailbox-full reply at `RCPT TO` is retried as well, and so is a `RCPT TO`
  rejection that is about the sender (`5.1.7`, `5.1.8`, `5.4.5`, "sender address rejected",
  "relay access denied", sending or rate limits).

**Behaviour to know:**
- Domain entries match the exact domain only (`acme.com` does not cover `mail.acme.com`).
- `jane+a@acme.com` and `jane@acme.com` are different addresses.
- Removing a suppression does not reset a lead already marked bounced or unsubscribed;
  change the lead's status too if it should be emailed again.

---

## Next Milestones

- [x] DB schema + migrations
- [x] Core utilities (spintax, variables, crypto, csv, rotation, transport, imap)
- [x] App shell — all routes, sidebar, layout
- [x] Sequences (multi-step) — create, edit, steps
- [x] Campaigns — create, launch, send loop in scheduler
- [x] Inbox / IMAP polling — fetch + reply detection
- [ ] Connections: "test connection" verification server action
- [ ] Leads: CSV upload → column mapping wizard → insert into DB (full flow)
- [ ] Campaign send-test / preview email server action
- [ ] Bounce/reply webhook handling
- [ ] Auth (single-user password or API key gate)
