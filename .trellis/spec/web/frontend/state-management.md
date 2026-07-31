# State Management in `apps/web`

> Code examples: `app/(dashboard)/leads/leads-view.tsx`, function
> `ImportWizardDialog` at line 419, and
> `app/(dashboard)/settings/unsubscribe-footer-form.tsx`.

---

## This app has no store

It uses no Redux, no Zustand, no Context for application data, and no React
Query. State lives in four places.

| Kind of state | Location |
|---|---|
| Server data | Props from a Server Component. `revalidatePath` in the action refreshes them. |
| Form and user interface state | `useState` in the client component |
| Mutation in progress | `useTransition` |
| Notifications | The `toast` function from `sonner` |

If you add a state library, update this spec. It is not a local decision.

## Run every mutation inside `useTransition`

Wrap each action call. The pending flag then drives the disabled state and the
spinner. Do not add a separate `loading` boolean.

```tsx
const [isPending, startTransition] = useTransition()

function handleImport() {
  startTransition(async () => {
    try {
      const targetListId = listId === 'new' ? await createList(newListName.trim()) : Number(listId)
      const allMapped = mapCSVRows(rawRows, mapping)
      const result = await importLeads(targetListId, allMapped)
      setImportResult(result)
      setStep('done')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    }
  })
}
```

The `try` and `catch` blocks are mandatory. A Server Action in this app can
reject. See the legacy throw pattern in the backend server-actions spec.

The catch block reads `err instanceof Error ? err.message : <fallback>`. The
message from the action therefore reaches the user, and no rejection becomes an
unhandled promise.

A simpler form uses a fixed message:

```tsx
try {
  await saveUnsubscribeFooter(value)
  toast.success('Opt-out footer saved')
} catch {
  toast.error('Failed to save opt-out footer')
}
```

## Write a multi-step flow as one `step` string and flat sibling state

The wizard uses no reducer. It does not nest the state of each step. One `step`
union controls the labels, the body, and the footer. Each other field is its own
`useState` call.

```tsx
const [step, setStep] = useState<WizardStep>('upload')
const [listId, setListId] = useState<string>('')
const [newListName, setNewListName] = useState('')
const [headers, setHeaders] = useState<string[]>([])
const [rawRows, setRawRows] = useState<Record<string, string>[]>([])
const [mapping, setMapping] = useState<ColumnMapping>({})
const [importResult, setImportResult] = useState<{ inserted: number; skipped: number } | null>(null)
```

The render is a chain of `{step === '...' && ( ... )}` blocks. The footer selects
its buttons the same way. The step labels come from one
`Record<WizardStep, string>`. If you add a step, you must therefore name it.

Guard each step change with a derived boolean. Never remove the validation
instead.

```tsx
const canProceedFromUpload =
  rawRows.length > 0 && (listId === 'new' ? newListName.trim().length > 0 : listId !== '')
// and at the next step:
<Button onClick={() => setStep('preview')} disabled={!mapping.email}>
```

## Compute derived values in the render

The preview rows and the totals come from `rawRows` and `mapping` on each render.
The code does not hold them in state, so they cannot become stale when the
mapping changes.

```tsx
const previewLeads =
  step === 'preview' || step === 'done' ? mapCSVRows(rawRows.slice(0, 5), mapping) : []
const totalMapped = step === 'preview' ? mapCSVRows(rawRows, mapping).length : 0
```

The `step` value gates both lines. The full-file `mapCSVRows` pass therefore runs
on one step only.

The file also uses `useMemo` for the filter and the sort of the lead table, at
lines 842, 864, and 879. Use `useMemo` when the input is large. Do not use it by
default.

## When a dialog opens, reset all of its state

A dialog stays mounted and the app reuses it. Each time it opens, clear the
previous run. This includes the uncontrolled file input, which `useState` cannot
reach.

```tsx
useEffect(() => {
  if (open) {
    setStep('upload')
    setListId(defaultListId ? String(defaultListId) : '')
    setHeaders([])
    setRawRows([])
    setMapping({})
    setImportResult(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }
}, [open, defaultListId])
```

CAUTION: Do not delete the `fileInputRef` line. Without it, the browser fires no
`change` event when the user selects the same file again. The wizard then keeps
the previous CSV and gives no error.

## Read and parse the file in the browser

`parseCSV`, `detectMapping`, and `mapCSVRows` are pure functions. The browser
runs them on the result from `FileReader`. Only the mapped rows cross the
network.

```tsx
const reader = new FileReader()
reader.onload = (ev) => {
  const text = ev.target?.result as string
  const { headers: h, rows: r, errors } = parseCSV(text)
  if (errors.length > 0) { toast.error(`CSV error: ${errors[0]}`); return }
  if (h.length === 0) { toast.error('No columns detected in CSV'); return }
  setHeaders(h)
  setRawRows(r)
  setMapping(detectMapping(h))
}
reader.readAsText(file)
```

The core package returns errors as data. This file turns them into toasts. The
core package does not decide the user experience.

CAUTION: The browser holds the whole file in memory, and one action call sends
the whole mapped array. The request body therefore limits the size of a CSV
file. This code has no streaming path.
