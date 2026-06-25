'use client'

import { useState, useTransition, useMemo, useEffect, useRef } from 'react'
import { Badge } from '@workspace/ui/components/badge'
import { Button } from '@workspace/ui/components/button'
import { Card, CardContent } from '@workspace/ui/components/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@workspace/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@workspace/ui/components/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@workspace/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@workspace/ui/components/tabs'
import { Textarea } from '@workspace/ui/components/textarea'
import {
  IconMailbox,
  IconFlame,
  IconSearch,
  IconRefresh,
  IconLoader,
  IconSettings,
  IconSend,
  IconMail,
  IconMailOpened,
  IconTag,
  IconChevronDown,
  IconCircleCheck,
  IconCircleX,
  IconCalendar,
  IconClock,
  IconBan,
  IconArrowDown,
  IconArrowUp,
  IconSelector,
} from '@tabler/icons-react'
import { toast } from 'sonner'
import type { InboundRow } from './page'
import { markRead, markUnread, replyToEmail, saveFilteredKeywords, triggerFetch, categorizeEmail, getOutboundMessages } from './actions'
import type { OutboundMessage } from './actions'

// ---------------------------------------------------------------------------
// Category config
// ---------------------------------------------------------------------------

type CategoryKey = 'none' | 'interested' | 'not_interested' | 'meeting_booked' | 'out_of_office' | 'do_not_contact'

const CATEGORIES: { value: CategoryKey; label: string; badge: string; icon: React.ReactNode }[] = [
  {
    value: 'none',
    label: 'Uncategorized',
    badge: '',
    icon: <IconTag className="size-3.5" />,
  },
  {
    value: 'interested',
    label: 'Interested',
    badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    icon: <IconCircleCheck className="size-3.5" />,
  },
  {
    value: 'not_interested',
    label: 'Not Interested',
    badge: 'bg-red-500/15 text-red-400 border-red-500/20',
    icon: <IconCircleX className="size-3.5" />,
  },
  {
    value: 'meeting_booked',
    label: 'Meeting Booked',
    badge: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
    icon: <IconCalendar className="size-3.5" />,
  },
  {
    value: 'out_of_office',
    label: 'Out of Office',
    badge: 'bg-orange-500/15 text-orange-400 border-orange-500/20',
    icon: <IconClock className="size-3.5" />,
  },
  {
    value: 'do_not_contact',
    label: 'Do Not Contact',
    badge: 'bg-muted text-muted-foreground border-border',
    icon: <IconBan className="size-3.5" />,
  },
]

function getCategoryMeta(value: string) {
  return CATEGORIES.find((c) => c.value === value) ?? CATEGORIES[0]!
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`
  const years = Math.floor(months / 12)
  return years === 1 ? '1 year ago' : `${years} years ago`
}

function filterRows(rows: InboundRow[], query: string): InboundRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(
    (r) =>
      r.fromEmail.toLowerCase().includes(q) ||
      r.fromName.toLowerCase().includes(q) ||
      r.subject.toLowerCase().includes(q) ||
      (r.bodyText ?? '').toLowerCase().includes(q),
  )
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

type SortKey = 'from' | 'subject' | 'category' | 'mailbox' | 'date'
type SortDir = 'asc' | 'desc'

function sortRows(rows: InboundRow[], key: SortKey, dir: SortDir, showLastInteraction: boolean): InboundRow[] {
  return [...rows].sort((a, b) => {
    let av: string
    let bv: string
    switch (key) {
      case 'from':
        av = (a.fromName || a.fromEmail).toLowerCase()
        bv = (b.fromName || b.fromEmail).toLowerCase()
        break
      case 'subject':
        av = (a.subject ?? '').toLowerCase()
        bv = (b.subject ?? '').toLowerCase()
        break
      case 'category':
        av = a.category ?? ''
        bv = b.category ?? ''
        break
      case 'mailbox':
        av = (a.connectionLabel ?? '').toLowerCase()
        bv = (b.connectionLabel ?? '').toLowerCase()
        break
      case 'date':
        if (showLastInteraction) {
          const aMax = a.repliedAt && a.receivedAt
            ? (a.repliedAt > a.receivedAt ? a.repliedAt : a.receivedAt)
            : (a.repliedAt ?? a.receivedAt ?? '')
          const bMax = b.repliedAt && b.receivedAt
            ? (b.repliedAt > b.receivedAt ? b.repliedAt : b.receivedAt)
            : (b.repliedAt ?? b.receivedAt ?? '')
          av = aMax; bv = bMax
        } else {
          av = a.receivedAt ?? ''
          bv = b.receivedAt ?? ''
        }
        break
    }
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
  })
}

function SortableHead({
  label,
  sortKey,
  current,
  dir,
  onSort,
  className,
}: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = current === sortKey
  return (
    <TableHead
      className={`cursor-pointer select-none ${className ?? ''}`}
      onClick={() => onSort(sortKey)}
    >
      <div className="flex items-center gap-1">
        {label}
        {active ? (
          dir === 'asc' ? (
            <IconArrowUp className="size-3 shrink-0 opacity-60" />
          ) : (
            <IconArrowDown className="size-3 shrink-0 opacity-60" />
          )
        ) : (
          <IconSelector className="size-3 shrink-0 opacity-30" />
        )}
      </div>
    </TableHead>
  )
}

// ---------------------------------------------------------------------------
// Category picker
// ---------------------------------------------------------------------------

function CategoryPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (cat: CategoryKey) => void
}) {
  const meta = getCategoryMeta(value)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <button
          className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 ${
            meta.badge || 'border-border text-muted-foreground'
          }`}
        >
          {meta.icon}
          {meta.value === 'none' ? <span className="text-muted-foreground">Categorize</span> : meta.label}
          <IconChevronDown className="size-2.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48" onClick={(e) => e.stopPropagation()}>
        {CATEGORIES.map((cat) => (
          <DropdownMenuItem
            key={cat.value}
            className="gap-2 text-sm"
            onSelect={() => onChange(cat.value)}
          >
            <span className={`flex items-center gap-1.5 ${cat.badge ? cat.badge.replace('bg-', 'text-').split(' ')[0] : 'text-muted-foreground'}`}>
              {cat.icon}
            </span>
            {cat.label}
            {cat.value === value && <span className="ml-auto text-xs opacity-50">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="bg-primary/10 mb-4 flex size-14 items-center justify-center rounded-full">
        <IconMailbox className="text-primary size-7" />
      </div>
      <p className="text-foreground text-sm font-medium">No {label} emails</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {label === 'filtered'
          ? 'Emails matching your filter keywords will appear here.'
          : label === 'interested'
          ? 'Mark emails as Interested to track them here.'
          : 'Received emails will appear here after the next sync.'}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Email detail + reply sheet — Telegram-style chat view
// ---------------------------------------------------------------------------

function EmailSheet({
  email,
  thread,
  onClose,
  onReplied,
  onCategoryChange,
}: {
  email: InboundRow
  thread: InboundRow[]
  onClose: () => void
  onReplied: (repliedAt: string) => void
  onCategoryChange: (id: number, cat: CategoryKey) => void
}) {
  const [replyBody, setReplyBody] = useState('')
  const [sending, startSending] = useTransition()
  const [outbound, setOutbound] = useState<OutboundMessage[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getOutboundMessages(email.id).then(setOutbound).catch(() => {})
  }, [email.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior })
  }, [outbound])

  function handleSend() {
    if (!replyBody.trim()) return
    startSending(async () => {
      const result = await replyToEmail(email.id, replyBody.trim())
      if (result.ok) {
        toast.success('Reply sent')
        setReplyBody('')
        // Refresh outbound so the new reply bubble appears immediately
        getOutboundMessages(email.id).then(setOutbound).catch(() => {})
        onReplied(new Date().toISOString())
      } else {
        toast.error(result.error ?? 'Failed to send reply')
      }
    })
  }

  // Merge inbound thread + outbound messages, sort chronologically
  const conversation = [
    ...thread.map((m) => ({ kind: 'inbound' as const, date: m.receivedAt ?? '', data: m })),
    ...outbound.map((m) => ({ kind: 'outbound' as const, date: m.sentAt ?? '', data: m })),
  ].sort((a, b) => a.date.localeCompare(b.date))

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="flex w-full max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="truncate text-base">{email.subject || '(no subject)'}</SheetTitle>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
            <span>
              From:{' '}
              <span className="text-foreground font-medium">
                {email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail}
              </span>
            </span>
            <span>·</span>
            <span>To: <span className="text-foreground">{email.toEmail}</span></span>
            {email.connectionLabel && (
              <>
                <span>·</span>
                <Badge variant="secondary" className="text-xs font-normal">
                  {email.connectionLabel}
                </Badge>
              </>
            )}
          </div>
          {/* Category row */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CATEGORIES.filter((c) => c.value !== 'none').map((cat) => {
              const active = email.category === cat.value
              return (
                <button
                  key={cat.value}
                  onClick={() => onCategoryChange(email.id, cat.value)}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium transition-all ${
                    active
                      ? cat.badge
                      : 'border-border text-muted-foreground hover:border-muted-foreground/40'
                  }`}
                >
                  {cat.icon}
                  {cat.label}
                </button>
              )
            })}
          </div>
        </SheetHeader>

        {/* Telegram-style conversation thread */}
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4 space-y-2">
          {conversation.length === 0 && (
            <p className="text-muted-foreground text-center text-sm py-8">Loading conversation…</p>
          )}
          {conversation.map((item) => {
            if (item.kind === 'outbound') {
              const msg = item.data
              return (
                <div key={`out-${msg.id}`} className="flex justify-end">
                  <div className="max-w-[80%]">
                    <div className="rounded-2xl rounded-tr-sm border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm">
                      <pre className="text-foreground whitespace-pre-wrap font-sans text-sm leading-relaxed">
                        {msg.body ?? '(empty)'}
                      </pre>
                    </div>
                    <p className="mt-1 text-right text-xs text-muted-foreground pr-1">
                      {msg.fromEmail ? `${msg.fromEmail} · ` : ''}{formatDate(msg.sentAt)}
                    </p>
                  </div>
                </div>
              )
            }

            const msg = item.data
            const isHighlighted = msg.id === email.id
            return (
              <div key={`in-${msg.id}`} className="flex justify-start">
                <div className="max-w-[80%]">
                  <div
                    className={`rounded-2xl rounded-tl-sm border px-4 py-3 text-sm transition-colors ${
                      isHighlighted
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border bg-card'
                    }`}
                  >
                    {msg.bodyHtml ? (
                      <div
                        className="prose prose-sm dark:prose-invert max-w-none text-sm"
                        dangerouslySetInnerHTML={{ __html: msg.bodyHtml }}
                      />
                    ) : (
                      <pre className="text-foreground whitespace-pre-wrap font-sans text-sm leading-relaxed">
                        {msg.bodyText ?? '(empty)'}
                      </pre>
                    )}
                  </div>
                  <p className="mt-1 text-left text-xs text-muted-foreground pl-1">
                    {msg.fromName || msg.fromEmail} · {formatDate(msg.receivedAt)}
                  </p>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>

        {/* Reply form */}
        <div className="border-t px-6 py-4 space-y-3">
          <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Reply from {email.connectionFromEmail ?? email.toEmail}
          </Label>
          <Textarea
            placeholder="Write your reply..."
            className="min-h-32 resize-none"
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            disabled={sending}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={sending}>
              Close
            </Button>
            <Button size="sm" onClick={handleSend} disabled={sending || !replyBody.trim()}>
              {sending ? (
                <IconLoader className="size-4 animate-spin" />
              ) : (
                <IconSend className="size-4" />
              )}
              Send Reply
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Filter keywords dialog
// ---------------------------------------------------------------------------

function FilteredKeywordsDialog({
  initialKeywords,
  onClose,
}: {
  initialKeywords: string
  onClose: () => void
}) {
  const [value, setValue] = useState(initialKeywords)
  const [saving, startSaving] = useTransition()

  function handleSave() {
    startSaving(async () => {
      await saveFilteredKeywords(value)
      toast.success('Filter keywords saved')
      onClose()
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Filter keywords</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-muted-foreground text-sm">
            Emails containing any of these keywords (in subject or body) will be moved to the
            Filtered tab. One keyword per line or separated by commas.
          </p>
          <Textarea
            className="min-h-32 resize-none font-mono text-sm"
            placeholder={"warmup\ntest email\nhello world"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={saving}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <IconLoader className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Inbox table
// ---------------------------------------------------------------------------

function LastInteractionCell({ row }: { row: InboundRow }) {
  const repliedAt = row.repliedAt ? new Date(row.repliedAt) : null
  const receivedAt = row.receivedAt ? new Date(row.receivedAt) : null

  const isReply = repliedAt && (!receivedAt || repliedAt > receivedAt)
  const date = isReply ? row.repliedAt : row.receivedAt

  return (
    <div className="flex items-center gap-1.5">
      {isReply ? (
        <IconArrowUp className="size-3 shrink-0 text-blue-400" />
      ) : (
        <IconArrowDown className="size-3 shrink-0 text-emerald-400" />
      )}
      <span className="text-muted-foreground text-sm">{formatDate(date)}</span>
    </div>
  )
}

function InboxTable({
  rows,
  emptyLabel,
  onRowClick,
  onCategoryChange,
  showLastInteraction = false,
}: {
  rows: InboundRow[]
  emptyLabel: string
  onRowClick: (row: InboundRow) => void
  onCategoryChange: (id: number, cat: CategoryKey) => void
  showLastInteraction?: boolean
}) {
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  if (rows.length === 0) return <EmptyState label={emptyLabel} />

  const sorted = sortRows(rows, sortKey, sortDir, showLastInteraction)

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-6" />
              <SortableHead label="From" sortKey="from" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortableHead label="Subject" sortKey="subject" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortableHead label="Category" sortKey="category" current={sortKey} dir={sortDir} onSort={handleSort} className="w-40" />
              <SortableHead label="Mailbox" sortKey="mailbox" current={sortKey} dir={sortDir} onSort={handleSort} />
              <SortableHead
                label={showLastInteraction ? 'Last interaction' : 'Received'}
                sortKey="date"
                current={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer"
                onClick={() => onRowClick(row)}
              >
                <TableCell className="pr-0">
                  {row.isRead ? (
                    <IconMailOpened className="text-muted-foreground size-4" />
                  ) : (
                    <IconMail className="text-primary size-4" />
                  )}
                </TableCell>
                <TableCell>
                  <p className={`text-sm leading-tight ${!row.isRead ? 'font-semibold' : 'font-normal'}`}>
                    {row.fromName || row.fromEmail}
                  </p>
                  {row.fromName && (
                    <p className="text-muted-foreground text-xs">{row.fromEmail}</p>
                  )}
                </TableCell>
                <TableCell className="max-w-72 truncate text-sm">
                  {row.subject || <span className="text-muted-foreground/40">(no subject)</span>}
                </TableCell>
                <TableCell>
                  <CategoryPicker
                    value={row.category}
                    onChange={(cat) => onCategoryChange(row.id, cat)}
                  />
                </TableCell>
                <TableCell>
                  {row.connectionLabel ? (
                    <Badge variant="secondary" className="text-xs font-normal">
                      {row.connectionLabel}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground/40 text-sm">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {showLastInteraction ? (
                    <LastInteractionCell row={row} />
                  ) : (
                    <span className="text-muted-foreground text-sm">{formatDate(row.receivedAt)}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function InboxView({
  emails,
  filteredKeywords,
}: {
  emails: InboundRow[]
  filteredKeywords: string
}) {
  const [search, setSearch] = useState('')
  const [selectedEmail, setSelectedEmail] = useState<InboundRow | null>(null)
  const [showKeywordsDialog, setShowKeywordsDialog] = useState(false)
  const [refreshing, startRefresh] = useTransition()
  const [localEmails, setLocalEmails] = useState<InboundRow[]>(emails)

  const inbox = useMemo(
    () => filterRows(localEmails.filter((e) => !e.isFiltered), search),
    [localEmails, search],
  )
  const interested = useMemo(
    () => filterRows(localEmails.filter((e) => !e.isFiltered && e.category === 'interested'), search),
    [localEmails, search],
  )
  const filtered = useMemo(
    () => filterRows(localEmails.filter((e) => e.isFiltered), search),
    [localEmails, search],
  )

  const unreadCount = localEmails.filter((e) => !e.isFiltered && !e.isRead).length

  function handleRowClick(row: InboundRow) {
    setSelectedEmail(row)
    if (!row.isRead) {
      setLocalEmails((prev) =>
        prev.map((e) => (e.id === row.id ? { ...e, isRead: true } : e)),
      )
      markRead(row.id).catch(() => {})
    }
  }

  function handleCategoryChange(id: number, cat: CategoryKey) {
    setLocalEmails((prev) =>
      prev.map((e) => (e.id === id ? { ...e, category: cat } : e)),
    )
    if (selectedEmail?.id === id) {
      setSelectedEmail((prev) => prev ? { ...prev, category: cat } : prev)
    }
    categorizeEmail(id, cat).catch(() => {
      toast.error('Failed to save category')
    })
  }

  function handleRefresh() {
    startRefresh(async () => {
      const result = await triggerFetch()
      if (result.ok) {
        toast.success('Inbox refreshed')
      } else {
        toast.error(result.error ?? 'Refresh failed')
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            All incoming email across your connected mailboxes.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowKeywordsDialog(true)}
          >
            <IconSettings className="size-4" />
            Filter keywords
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            {refreshing ? (
              <IconLoader className="size-4 animate-spin" />
            ) : (
              <IconRefresh className="size-4" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <IconSearch className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
        <Input
          className="pl-9"
          placeholder="Search by sender, subject, or content..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Tabs defaultValue="inbox">
        <TabsList>
          <TabsTrigger value="inbox" className="gap-1.5">
            <IconMailbox className="size-3.5" />
            Inbox
            {unreadCount > 0 && (
              <span className="bg-primary/15 text-primary rounded px-1.5 py-0.5 text-xs font-medium">
                {unreadCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="interested" className="gap-1.5">
            <IconCircleCheck className="size-3.5" />
            Interested
            {interested.length > 0 && (
              <span className="bg-emerald-500/15 text-emerald-400 rounded px-1.5 py-0.5 text-xs font-medium">
                {interested.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="filtered" className="gap-1.5">
            <IconFlame className="size-3.5" />
            Filtered
            {filtered.length > 0 && (
              <span className="bg-orange-500/15 text-orange-400 rounded px-1.5 py-0.5 text-xs font-medium">
                {filtered.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="inbox" className="mt-4">
          <InboxTable
            rows={inbox}
            emptyLabel="inbox"
            onRowClick={handleRowClick}
            onCategoryChange={handleCategoryChange}
          />
        </TabsContent>

        <TabsContent value="interested" className="mt-4">
          <InboxTable
            rows={interested}
            emptyLabel="interested"
            onRowClick={handleRowClick}
            onCategoryChange={handleCategoryChange}
            showLastInteraction
          />
        </TabsContent>

        <TabsContent value="filtered" className="mt-4">
          <InboxTable
            rows={filtered}
            emptyLabel="filtered"
            onRowClick={handleRowClick}
            onCategoryChange={handleCategoryChange}
          />
        </TabsContent>

      </Tabs>

      {selectedEmail && (
        <EmailSheet
          email={selectedEmail}
          thread={localEmails
            .filter((e) => e.fromEmail === selectedEmail.fromEmail)
            .sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? ''))}
          onClose={() => setSelectedEmail(null)}
          onReplied={(repliedAt) => {
            // Keep the sheet open — just update repliedAt/isRead in the row
            setLocalEmails((prev) =>
              prev.map((e) =>
                e.id === selectedEmail.id ? { ...e, repliedAt, isRead: true } : e,
              ),
            )
          }}
          onCategoryChange={handleCategoryChange}
        />
      )}

      {showKeywordsDialog && (
        <FilteredKeywordsDialog
          initialKeywords={filteredKeywords}
          onClose={() => setShowKeywordsDialog(false)}
        />
      )}
    </div>
  )
}
