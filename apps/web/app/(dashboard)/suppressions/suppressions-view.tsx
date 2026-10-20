'use client'

import { useState, useTransition, useRef, useMemo } from 'react'
import { toast } from 'sonner'
import { Button } from '@workspace/ui/components/button'
import { Badge } from '@workspace/ui/components/badge'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Card, CardContent } from '@workspace/ui/components/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@workspace/ui/components/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@workspace/ui/components/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select'
import {
  IconUpload,
  IconPlus,
  IconTrash,
  IconLoader,
  IconSearch,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react'
import { addSuppression, removeSuppression, importSuppressionsCsv } from './actions'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuppressionRow = {
  id: number
  kind: string
  value: string
  reason: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reasonBadge(reason: string) {
  if (reason === 'unsubscribed')
    return <Badge className="bg-amber-500/15 text-amber-400 hover:bg-amber-500/15">Unsubscribed</Badge>
  if (reason === 'stop_reply')
    return <Badge className="bg-amber-500/15 text-amber-400 hover:bg-amber-500/15">STOP reply</Badge>
  if (reason === 'bounced')
    return <Badge className="bg-red-500/15 text-red-400 hover:bg-red-500/15">Bounced</Badge>
  if (reason === 'manual') return <Badge variant="secondary">Manual</Badge>
  if (reason === 'import') return <Badge variant="secondary">Imported</Badge>
  return <Badge variant="secondary">{reason}</Badge>
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

// ---------------------------------------------------------------------------
// Add dialog
// ---------------------------------------------------------------------------

// The form lives inside DialogContent, which unmounts on close, so its state resets on its own.
function AddForm({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      try {
        const added = await addSuppression(value)
        toast.success(`${added.value} added`)
        onDone()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to add')
      }
    })
  }

  return (
    <>
      <form id="add-suppression-form" onSubmit={handleSubmit} className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="suppression-value">Email or domain</Label>
          <Input
            id="suppression-value"
            placeholder="jane@example.com or @example.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            autoFocus
          />
        </div>
      </form>
      <DialogFooter showCloseButton>
        <Button type="submit" form="add-suppression-form" disabled={isPending || !value.trim()}>
          {isPending && <IconLoader className="mr-1.5 size-4 animate-spin" />}
          Add
        </Button>
      </DialogFooter>
    </>
  )
}

function AddDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add to suppression list</DialogTitle>
          <DialogDescription>
            An email address, or a domain such as @example.com to block everyone at it.
          </DialogDescription>
        </DialogHeader>
        <AddForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function SuppressionsView({ entries }: { entries: SuppressionRow[] }) {
  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [isPending, startTransition] = useTransition()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => e.value.includes(q))
  }, [entries, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  function updateSearch(value: string) {
    setSearch(value)
    setPage(1)
  }

  function updatePageSize(value: string) {
    setPageSize(Number(value))
    setPage(1)
  }

  function handleRemove(entry: SuppressionRow) {
    setRemovingId(entry.id)
    startTransition(async () => {
      await removeSuppression(entry.id)
      setRemovingId(null)
      toast.success(`${entry.value} removed`)
    })
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      startTransition(async () => {
        try {
          const result = await importSuppressionsCsv(text)
          const parts = [`${result.inserted} added`]
          if (result.duplicate > 0) parts.push(`${result.duplicate} duplicate`)
          if (result.invalid > 0) parts.push(`${result.invalid} invalid`)
          toast.success(`Import complete: ${parts.join(', ')}`)
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Import failed')
        }
      })
    }
    reader.readAsText(file)
    // Allow picking the same file again.
    e.target.value = ''
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Suppressions</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Addresses and domains that are never emailed, across every list and campaign.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => fileInputRef.current?.click()}
            disabled={isPending}
          >
            <IconUpload className="size-4" />
            Import CSV
          </Button>
          <Button className="gap-2" onClick={() => setAddOpen(true)}>
            <IconPlus className="size-4" />
            Add
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm min-w-[220px] flex-1">
          <IconSearch className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
          <Input
            className="pl-9"
            placeholder="Search by email or domain..."
            value={search}
            onChange={(e) => updateSearch(e.target.value)}
          />
        </div>
        <span className="text-muted-foreground ml-auto text-sm">
          {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email or domain</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-muted-foreground py-12 text-center text-sm"
                  >
                    {entries.length === 0
                      ? 'Nothing suppressed yet. Unsubscribes and hard bounces are added automatically.'
                      : 'No entries match your search.'}
                  </TableCell>
                </TableRow>
              ) : (
                paged.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-medium">
                      {entry.kind === 'domain' ? `@${entry.value}` : entry.value}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {entry.kind === 'domain' ? 'Domain' : 'Email'}
                    </TableCell>
                    <TableCell>{reasonBadge(entry.reason)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={`Remove ${entry.value}`}
                        disabled={isPending && removingId === entry.id}
                        onClick={() => handleRemove(entry)}
                      >
                        {isPending && removingId === entry.id ? (
                          <IconLoader className="size-4 animate-spin" />
                        ) : (
                          <IconTrash className="size-4" />
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Rows per page</span>
          <Select value={String(pageSize)} onValueChange={updatePageSize}>
            <SelectTrigger className="w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <IconChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              <IconChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <AddDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}
