# Component Guidelines for `apps/web`

> Code examples: `app/(dashboard)/leads/leads-view.tsx` and
> `app/(dashboard)/settings/unsubscribe-footer-form.tsx`.

---

## Import order

Write `'use client'` first. Then import in this order: React, third-party
packages, `@workspace/ui`, icons, `@workspace/core`, and the local actions.

```ts
'use client'

import { useState, useTransition, useEffect, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import { Button } from '@workspace/ui/components/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@workspace/ui/components/dialog'
import { IconUpload, IconLoader } from '@tabler/icons-react'
import { parseCSV, detectMapping, mapCSVRows, LEAD_FIELDS } from '@workspace/core/csv'
import type { ColumnMapping } from '@workspace/core/csv'
import { createList, importLeads } from './actions'
```

Import each user interface component from its own subpath, for example
`@workspace/ui/components/button`. Never import a barrel from `@workspace/ui`.

Inside the file, divide the regions with banner comments: `Types`, `Helpers`, and
one comment for each sub-component. `packages/core/src/csv.ts` uses the same
style.

## Write props as an inline object type

Destructure the props in the signature. Do not write an `interface FooProps`. Do
not use `React.FC`.

```tsx
function ImportWizardDialog({
  open,
  onOpenChange,
  lists,
  defaultListId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  lists: ListWithCount[]
  defaultListId?: number
}) {
```

## Export the row types from the view file

The client file owns the shape that it receives. `page.tsx` then matches that
shape.

```ts
export type ListWithCount = { id: number; name: string; leadCount: number; createdAt: string }
export type LeadRow = { id: number; listId: number; firstName: string; /* ... */ status: string }
```

`createdAt` is a `string`, not a `Date`. The page serializes it first. See the
backend data-loading spec.

## Control every dialog from the parent

A dialog accepts `open` and `onOpenChange`. The parent view renders it. The
dialog does not own its trigger.

```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="sm:max-w-2xl overflow-y-auto max-h-[90vh]">
    <DialogHeader>
      <DialogTitle>Import CSV</DialogTitle>
    </DialogHeader>
    {/* body */}
    <DialogFooter showCloseButton>{/* actions */}</DialogFooter>
  </DialogContent>
</Dialog>
```

If a click outside the dialog can delete the work of the user, block that click:

```tsx
onInteractOutside={(e) => e.preventDefault()}
```

## Disable the controls and render a spinner while an action runs

The spinner is always `IconLoader` with `animate-spin`. Render it inside the
button, before the label.

```tsx
<Button size="sm" onClick={handleSave} disabled={saving || !dirty || isBlank}>
  {saving && <IconLoader className="size-4 animate-spin" />}
  Save
</Button>
```

Combine the pending state with the validity in the `disabled` condition. In this
example `!dirty` stops a save that changes nothing. `isBlank` stops an invalid
save.

## Render each status through one mapping function

Do not write status colours at the call site. `statusBadge(status)` is one
function. It returns a `Badge` and it handles an unknown value.

```tsx
function statusBadge(status: string) {
  if (status === 'new') return <Badge variant="secondary">New</Badge>
  if (status === 'contacted')
    return <Badge className="bg-blue-500/15 text-blue-400 hover:bg-blue-500/15">Contacted</Badge>
  // ...
  return <Badge variant="secondary">{status}</Badge>
}
```

Apply the same rule to field labels. Write one `Record` that uses the core
constant as its key type. A new entry in `LEAD_FIELDS` then causes a type error
here.

```ts
const LEAD_FIELD_LABELS: Record<(typeof LEAD_FIELDS)[number], string> = {
  firstName: 'First name',
  email: 'Email (required)',
  // ...
}
```

CAUTION: These badge classes are literal Tailwind colours, for example
`bg-blue-500/15`. They are not semantic tokens. This is the one exception in the
file, and it applies to status badges only. All other code uses
`text-muted-foreground`, `bg-background`, `border-border`, and the other tokens.
Do not use literal colours in new code.

## Styles

Write Tailwind utilities inline. Size each icon with `size-4`. Use the semantic
token classes. The theme is dark first, and the repo handbook forbids a hex or
hsl value.
