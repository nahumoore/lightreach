# Lightreach

A free, open-source, self-hosted cold-email outreach platform — a lightweight alternative
to Instantly, Smartlead, and lemlist.

Send personalized emails at scale using your own SMTP mailboxes. No paid SaaS, no data
leaving your machine, no per-seat pricing.

![Campaign Creation Demo](./lightreach-demo-official.gif)

## Features

- **Multiple connections** — add any number of SMTP mailboxes (Gmail, Outlook, custom); test, pause, and track daily limits per mailbox
- **Inbox / IMAP** — poll received mail across all mailboxes; automatic reply and warmup detection
- **Leads** — upload CSVs with a visual column-mapping wizard; manage lists and individual contacts
- **Sequences** — multi-step email sequences with configurable delays between steps; write with `{spintax|options}` and `{{variable|fallback}}` placeholders; live preview
- **Campaigns** — pair a sequence with a lead list; choose which mailboxes to rotate across; set a send schedule
- **Scheduling** — send-window (time of day), days of week, daily cap, and randomized delay jitter between sends
- **Email rotation** — spread sends evenly across mailboxes; respect per-account daily limits
- **Dashboard** — activity overview and send analytics

## Requirements

- **Node.js >= 20**
- **pnpm >= 10** (`npm install -g pnpm`)

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Set up environment
cp .env.example .env.local
# Edit .env.local — generate APP_ENCRYPTION_KEY with:
#   openssl rand -hex 32

# 3. Initialize database
pnpm db:generate
pnpm db:migrate

# 4. Start the app
pnpm dev
# → http://localhost:3000
```

> **Production note:** the background scheduler and inbox poller run inside the Node.js
> process. Use `pnpm build && pnpm start` (not a serverless platform) so they keep ticking
> between requests.

## Stack

- **Next.js 16** (App Router) + **React 19**
- **Tailwind CSS v4** + **shadcn/ui** (dark theme, blue primary)
- **SQLite** + **Drizzle ORM** (zero config, single file — `data.db`)
- **Nodemailer** (SMTP send) + **imapflow** (IMAP receive)
- **TypeScript 5** strict
- **pnpm workspaces** + **Turborepo** monorepo

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `APP_ENCRYPTION_KEY` | ✅ | 64 hex chars (32 bytes). Encrypt SMTP passwords at rest. Generate: `openssl rand -hex 32` |
| `DATABASE_URL` | — | SQLite path. Defaults to `file:./data.db` |

## Security

- SMTP and IMAP passwords are encrypted at rest with AES-256-GCM using `APP_ENCRYPTION_KEY`.
- `APP_ENCRYPTION_KEY` and `data.db` are git-ignored and never leave your machine.
- If you ever share the project folder, delete or regenerate these files first.

## Documentation

See [CLAUDE.md](./CLAUDE.md) for the full developer handbook: architecture, conventions,
commands, data model, and scheduler design.

## License

MIT — see [LICENSE](./LICENSE).

---

Lightreach helps you send cold outreach. If you also want to automate the *discovery*
side of link building — finding relevant backlink opportunities (guest posts, resource
pages, roundups) and drafting outreach for your approval — check out
[Mentiohunt](https://mentiohunt.com), another project of mine.
