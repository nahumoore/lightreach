# Bootstrap Trellis specs for the Leads CSV import work

## Problem

`trellis init` generated 40 spec files under `.trellis/spec/`. Every one of them
is an unfilled template (`(To be filled by the team)`, status `To fill`). The
generated shape is also wrong for this repo: it produced `frontend/` trees for
`db`, `eslint-config`, and `typescript-config`, none of which contain frontend
code, and a `core/frontend/` tree for a package that is Node-only business logic.

The result is that a Trellis spec lookup returns boilerplate questions instead of
this project's actual conventions.

## Scope

Write real, code-backed specs for the packages touched by the Leads CSV import
flow, and delete the unused stubs. Packages in scope:

| Package | Layer(s) | Why in scope |
|---|---|---|
| `apps/web` | backend + frontend | `leads/page.tsx`, `leads/actions.ts`, `leads-view.tsx` |
| `packages/core` | backend | `src/csv.ts` |
| `packages/db` | backend | `lists` / `leads` tables, client |

Out of scope, recorded in `index.md` as not yet specced: `packages/ui` (consumed
only), `packages/eslint-config`, `packages/typescript-config`.

## Context: the wizard already shipped

The CSV import wizard is already implemented — `leads-view.tsx:419`
(`ImportWizardDialog`) runs an `upload → map → preview → done` step machine and
calls `parseCSV` / `detectMapping` / `mapCSVRows` / `importLeads`. The
`CLAUDE.md` milestone claiming it is unbuilt is stale, as is the Connections
"test connection" milestone (`connections/actions.ts:129`).

Specs are still written for these packages: the next Leads work is refinement of
this code, so the conventions are what a future session needs. Decision recorded
by the developer: proceed with this scope even though the wizard shipped.

## Requirements

1. Organize specs per package under `.trellis/spec/<package>/<layer>/`,
   referenced from a rewritten parent `index.md`. No merged cross-package spec.
2. Spec only the three in-scope packages. List the rest as "not yet specced".
3. Cite at least one real file per documented pattern. No invented conventions:
   if no code example exists, the pattern is omitted.
4. Where two patterns coexist, document the dominant one and mark the other
   "present, do not propagate".
5. Delete every unused template stub, including `ui/frontend/`.
6. Strip the stale milestone list from `CLAUDE.md`.

## Decisions taken

- **Server action returns**: the result-object form
  (`Promise<{ ok: boolean; error?: string }>`, `connections/actions.ts:129`) is
  dominant. The `throw new Error` form (`leads/actions.ts:68`, `:100`) is legacy
  — present, do not propagate. Note that `leads/actions.ts` is a file this work
  will edit, so it carries the legacy pattern today.
- **Absences are one-liners in `index.md`, not spec files.** Three of them:
  - no test runner, test script, or test file exists in any package;
  - no logger exists — `console.*` appears only in `lib/scheduler.ts` and
    `lib/inbox-poller.ts`;
  - no dashboard auth exists — the only auth check is MCP bearer
    (`lib/mcp/auth.ts`), covering `/api/mcp` alone.
- **`ui/frontend/` is deleted** despite `packages/ui` being a genuine frontend
  package, because the stubs are unfilled and the package is out of scope. It is
  recorded in `index.md` as "not yet specced (consumed only)".

## Follow-up: Simplified Technical English pass

All 11 spec files were rewritten with the `simple-english` skill, pragmatic mode.

Fixed vocabulary for the document set: **make sure that** (not
check/verify/confirm/validate/ensure), **configuration** (not config/settings),
**run** (not execute/invoke/launch), **delete** (not remove/drop), **error** for
errors and **failure** for failed operations. Modals limited to can/will/must.

Verified after the rewrite:

- 0 sentences over the 20-word procedural limit (inline code counts as one word
  per Rule 8.6, parentheses as one word per Rule 8.5).
- 0 banned modals, contractions, Latin abbreviations, or slop terms.
- 0 prose semicolons (Rule 8.1) and 0 authored em dashes.
- Every `if` and `when` that gates a command leads its sentence (Rule 5.4).
- Risk statements converted to the `CAUTION:` pattern, command first, risk
  second (Rules 7.1 to 7.3).
- All cited file paths still resolve.

Two em dashes remain, at `db/backend/schema-guidelines.md:15` and
`web/backend/index.md:62`. Both are verbatim source comments inside code fences,
which the skill classifies as Untouchable.

The `guides/` directory was left unchanged. It is upstream Trellis content and
does not follow these rules.

## Acceptance criteria

- [x] `.trellis/spec/index.md` maps every workspace package as specced or not
      yet specced, and carries the three absence one-liners.
- [x] `web/backend/`, `web/frontend/`, `core/backend/`, `db/backend/` contain
      only filled specs; no `(To be filled by the team)` string survives
      anywhere under `.trellis/spec/`.
- [x] Every pattern in every spec cites a real file that exists at that path
      (all 23 cited paths verified present).
- [x] The legacy throw-based action return is marked do-not-propagate.
- [x] 35 stub files deleted; `guides/` left untouched.
- [x] `CLAUDE.md` no longer contains the stale milestone list; replaced with a
      pointer to `.trellis/spec/index.md`.
- [ ] `pnpm typecheck` — **could not run.** The workspace `node_modules` is
      incomplete: no `.bin` directories exist, so `turbo` and `tsc` are both
      unresolvable (`sh: tsc: command not found` in all three packages). This is
      pre-existing and unrelated to this task, which changed only Markdown. Needs
      a `pnpm install` before any code work starts.
