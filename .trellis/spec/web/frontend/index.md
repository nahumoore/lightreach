# `apps/web` Frontend Guidelines

> Client Components under `app/(dashboard)/`, built on `@workspace/ui`.

---

## Shape of a feature user interface

Write one `'use client'` file for each feature. Name it `<feature>-view.tsx`. It
exports one view component, and the page renders that component.

Keep the sub-components in the same file. Dialogs, row actions, and forms all
live there. `leads-view.tsx` is 1164 lines and holds the whole Leads user
interface, including the CSV import wizard.

One exception applies. If a form is small and self-contained, give it its own
file. `settings/unsubscribe-footer-form.tsx` is such a form.

## Guidelines index

| Guide | Subject |
|---|---|
| [Component Guidelines](./component-guidelines.md) | Component shape, props, `@workspace/ui` imports, styles |
| [State Management](./state-management.md) | Local state, transitions, multi-step wizards, toasts |

## Stack facts that control this work

- **Next.js 16 App Router.** Before you depend on framework behaviour, read the
  guide in `apps/web/node_modules/next/dist/docs/`. The repo handbook warns that
  this release is not the familiar Next.js.
- **React 19.2.** The `react` and `react-dom` versions are pinned to `19.2.4`.
- **Tailwind v4** with CSS-first configuration. The tokens live in
  `packages/ui/src/styles/globals.css`.
- **shadcn/ui through `@workspace/ui`**, with Tabler icons.
- **Dark theme first, blue primary.** Use the semantic tokens, for example
  `bg-background`, `text-muted-foreground`, and `border-border`. Never write a
  hex or hsl value.
- This app has no form library, no global state library, and no client-side
  data-fetching library.

## Commands

```bash
pnpm --filter web dev         # next dev
pnpm --filter web lint        # eslint
pnpm --filter web typecheck   # tsc --noEmit
pnpm --filter web format      # prettier --write "**/*.{ts,tsx}"
```

## To add a shadcn component

Run this command from the repo root. It installs the component into
`packages/ui`, not into the app.

```bash
pnpm dlx shadcn@latest add <component> -c apps/web
```
