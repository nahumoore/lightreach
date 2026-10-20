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
| **Mailbox health** | Per-mailbox bounce rate over a rolling window. Mailboxes at or above the threshold are auto-paused. Shown on Connections, tuned in Settings, exposed over MCP. |
| **Inbox / Emails** | Poll received mail across all IMAP mailboxes. Automatic reply and warmup detection. |
| **Leads** | Upload CSVs with column-mapping wizard. Manage lists + individual leads. |
| **Sequences** | Multi-step email sequences with configurable `delayDays` between steps. Write with `{spintax\|options}` and `{{variable\|fallback}}` placeholders. Live preview. |
| **Campaigns** | Pair a sequence with a lead list, assign mailboxes to rotate across, set schedule. |
| **Scheduling** | Send-window (time of day), days of week, daily cap, min/max delay jitter between sends. |
| **Settings** | App-level defaults, encryption key status, sending behavior, mailbox health thresholds. |

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
│   │   └── src/email/imap.ts       # imapflow IMAP polling + reply detection
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
```

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
| `connections` | SMTP/IMAP mailboxes: host, port, auth, daily limit, `healthResetAt` (bounce history starts here), `healthPausedAt` (set on auto-pause) |
| `lists` | Named lead lists |
| `leads` | Individual contacts linked to a list |
| `sequences` | Multi-step email sequences (replaced `templates`) |
| `sequence_steps` | Individual steps: subject, body, delayDays |
| `campaigns` | Pair sequence + list + mailboxes + schedule |
| `campaign_connections` | Many-to-many: campaign ↔ connection (rotation set) |
| `messages` | Per-lead send queue + delivery log (`failedAt` marks SMTP hard bounces) |
| `inbound_emails` | Received mail fetched via IMAP (replies, warmup) |
| `app_settings` | Key-value store for app-level preferences (filter keywords, MCP token, `health_*` thresholds) |

See `packages/db/src/schema.ts` for full column definitions.

---

## In-Process Scheduler & Inbox Poller

`apps/web/instrumentation.ts` boots the background jobs (scheduler, inbox poller and the
mailbox health monitor below) on the Node.js runtime. All are **Node-only** — they will not
run in Edge or serverless environments. For production use, run the app as a persistent Node
process (`pnpm build && pnpm start`), not on a serverless platform that spins down between
requests.

**Scheduler loop** (`lib/scheduler.ts`):
1. Find `messages` with `status = 'queued'` and `scheduledAt <= now`
2. Pick the next active mailbox via `rotation.pickNext(campaignId)`
3. Respect send window (time of day + days of week)
4. Respect per-connection `dailyLimit` and per-campaign `dailyCap`
5. Apply `minDelaySeconds`/`maxDelaySeconds` jitter between sends
6. Call `transport.sendMail(connection, message)` → update `messages.status`

**Inbox poller** (`lib/inbox-poller.ts`):
Periodically fetches new mail via IMAP across all active connections with IMAP configured,
stores them in `inbound_emails`, and marks any matching outbound `messages` as replied.

---

## Mailbox health

`lib/health.ts` measures each mailbox's bounce rate and pauses mailboxes that cross a threshold.
`instrumentation.ts` starts `startHealthMonitor()`, which runs `runHealthCheck()` every 10 minutes
(and once at startup).

**Bounce rate** = bounces / sends over the last `health_window_days`, never reaching back
before the mailbox's `connections.healthResetAt`. Only campaign mail counts (`stepPosition > 0`).
- Sends: `messages` with `status = 'sent'` from the mailbox, plus SMTP hard bounces.
- SMTP hard bounces: `messages` with `status = 'failed'` and a `failedAt` in the window. The
  scheduler sets `connectionId` and `failedAt` on a failed row only for hard bounces (550-554), so
  transient failures never count.
- Inbox bounces: `inbound_emails` with `isBounce = true` and `isDuplicate = false` on the mailbox's
  `connectionId`, minus delay notices (subject containing "delay" unless it also says
  "undeliverable", or a body with "Action: delayed" / "Delivery incomplete"; best effort, since
  only subject and plain text are stored). These notices have no lead link, so each notice counts
  once. With IMAP off only the SMTP-time hard bounces are visible.

**Auto-pause:** an `active` mailbox with at least `health_min_sends` sends and a rate at or above
`health_bounce_threshold` is set to `paused`, `healthPausedAt` is stamped (this is what the UI and
MCP treat as "auto-paused"), and `lastError` gets a `Health:` reason for humans. The write is
conditional on the mailbox still being `active` with an unchanged `healthResetAt`. Paused and
errored mailboxes are skipped; nothing is deleted. **Auto-pause is on by default.** Turn it off
with the switch under Settings, Mailbox health, or `set_health_settings` with `autoPause: false`;
the rates are still computed and shown.

**Resuming:** an auto-paused mailbox is resumed only with `toggleConnectionStatus` (it reads the
stored status, not the caller's). That sets `healthResetAt = now` so the old bounces don't pause it
again, and clears `healthPausedAt` and the `Health:` `lastError`. `testConnection` on an auto-paused
mailbox only updates `lastTestedAt` and the DNS result.

| `app_settings` key | Default |
|---|---|
| `health_bounce_threshold` | `5` (percent) |
| `health_window_days` | `7` |
| `health_min_sends` | `20` |
| `health_auto_pause` | `true` |

Thresholds are edited in **Settings** or over MCP. MCP tools: `get_mailbox_health`,
`set_health_settings`, `run_health_check`.

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
