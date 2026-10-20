'use client'

import { useState, useTransition, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@workspace/ui/components/button'
import { Badge } from '@workspace/ui/components/badge'
import { Input } from '@workspace/ui/components/input'
import { Label } from '@workspace/ui/components/label'
import { Switch } from '@workspace/ui/components/switch'
import {
  Card,
  CardContent,
  CardTitle,
  CardDescription,
} from '@workspace/ui/components/card'
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
  DialogFooter,
} from '@workspace/ui/components/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@workspace/ui/components/tooltip'
import {
  IconMailPlus,
  IconPlugConnected,
  IconDots,
  IconLoader,
  IconWifi,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconTrash,
  IconCheck,
  IconX,
  IconFlame,
} from '@tabler/icons-react'
import type { WarmupStatus } from '@/lib/warmup'
import {
  createConnection,
  updateConnection,
  deleteConnection,
  toggleConnectionStatus,
  testConnection,
  testConnectionDraft,
  updateWarmupSettings,
  triggerWarmup,
} from './actions'

export type DnsRecords = {
  spf: boolean
  dkim: boolean
  dmarc: boolean
  valid: boolean
  checkedAt: string
} | null

export type SafeConnection = {
  id: number
  label: string
  fromName: string
  fromEmail: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  dailyLimit: number
  status: string
  lastTestedAt: string | null
  lastError: string | null
  dnsRecords: DnsRecords
  createdAt: string
  imapEnabled: boolean
  imapSameAsSmtp: boolean
  imapHost: string | null
  imapPort: number | null
  imapSecure: boolean | null
  imapUser: string | null
  warmup: WarmupStatus | null
}

type FormValues = {
  label: string
  fromName: string
  fromEmail: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser: string
  smtpPass: string
  dailyLimit: number
  imapEnabled: boolean
  imapSameAsSmtp: boolean
  imapHost: string
  imapPort: number
  imapSecure: boolean
  imapUser: string
  imapPass: string
}

const emptyForm: FormValues = {
  label: '',
  fromName: '',
  fromEmail: '',
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPass: '',
  dailyLimit: 50,
  imapEnabled: false,
  imapSameAsSmtp: true,
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  imapUser: '',
  imapPass: '',
}

function statusBadge(status: string) {
  if (status === 'active')
    return (
      <Badge className="bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15">
        Active
      </Badge>
    )
  if (status === 'paused')
    return (
      <Badge className="bg-amber-500/15 text-amber-400 hover:bg-amber-500/15">
        Paused
      </Badge>
    )
  if (status === 'error')
    return (
      <Badge className="bg-red-500/15 text-red-400 hover:bg-red-500/15">
        Error
      </Badge>
    )
  return <Badge variant="secondary">{status}</Badge>
}

function dnsRecordRow(label: string, ok: boolean) {
  return (
    <div key={label} className="flex items-center justify-between gap-4 text-xs">
      <span>{label}</span>
      {ok ? (
        <IconCheck className="size-3.5 text-emerald-400" />
      ) : (
        <IconX className="size-3.5 text-red-400" />
      )}
    </div>
  )
}

function dnsBadge(dns: DnsRecords) {
  if (!dns) return <Badge variant="secondary">Not checked</Badge>

  const badge = dns.valid ? (
    <Badge className="bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15">Valid</Badge>
  ) : (
    <Badge className="bg-red-500/15 text-red-400 hover:bg-red-500/15">Missing</Badge>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default">{badge}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex flex-col gap-1 px-3 py-2">
        {dnsRecordRow('SPF', dns.spf)}
        {dnsRecordRow('DKIM', dns.dkim)}
        {dnsRecordRow('DMARC', dns.dmarc)}
      </TooltipContent>
    </Tooltip>
  )
}

function warmupCell(warmup: WarmupStatus | null) {
  if (!warmup || warmup.state === 'off') {
    return <span className="text-muted-foreground text-xs">Off</span>
  }

  const summary =
    warmup.state === 'waiting' ? (
      <Badge variant="secondary">Waiting</Badge>
    ) : (
      <span className="text-xs">
        {warmup.sentToday}/{warmup.todayTarget} today
        <span className="text-muted-foreground"> · day {warmup.rampDay}</span>
      </span>
    )

  const week = warmup.last7Days
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1.5">
          {summary}
          {warmup.lastError && <IconX className="size-3.5 text-red-400" />}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex max-w-xs flex-col gap-1 px-3 py-2 text-xs">
        {warmup.reason && <span>{warmup.reason}</span>}
        <span>
          Last 7 days: {week.inbox} inbox · {week.spam} spam · {week.missing} missing
          {week.pending > 0 && ` · ${week.pending} pending`}
        </span>
        <span>Replies sent today: {warmup.repliesToday}</span>
        {warmup.lastError && <span className="text-red-400">{warmup.lastError}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

function formatLastTested(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

interface ConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editConnection?: SafeConnection
}

function ConnectionDialog({ open, onOpenChange, editConnection }: ConnectionDialogProps) {
  const isEdit = !!editConnection
  const [form, setForm] = useState<FormValues>(emptyForm)
  const [isPending, startTransition] = useTransition()
  const [isTestPending, startTestTransition] = useTransition()

  useEffect(() => {
    if (open) {
      setForm(
        isEdit
          ? {
              label: editConnection.label,
              fromName: editConnection.fromName,
              fromEmail: editConnection.fromEmail,
              smtpHost: editConnection.smtpHost,
              smtpPort: editConnection.smtpPort,
              smtpSecure: editConnection.smtpSecure,
              smtpUser: editConnection.smtpUser,
              smtpPass: '',
              dailyLimit: editConnection.dailyLimit,
              imapEnabled: editConnection.imapEnabled,
              imapSameAsSmtp: editConnection.imapSameAsSmtp,
              imapHost: editConnection.imapHost ?? '',
              imapPort: editConnection.imapPort ?? 993,
              imapSecure: editConnection.imapSecure ?? true,
              imapUser: editConnection.imapUser ?? '',
              imapPass: '',
            }
          : emptyForm,
      )
    }
  }, [open, editConnection, isEdit])

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleTest() {
    startTestTransition(async () => {
      const toastId = toast.loading('Testing connection…')
      const result = await testConnectionDraft({
        smtpHost: form.smtpHost,
        smtpPort: form.smtpPort,
        smtpSecure: form.smtpSecure,
        smtpUser: form.smtpUser,
        smtpPass: form.smtpPass,
      })
      if (result.ok) {
        toast.success('SMTP connection verified', { id: toastId })
      } else {
        toast.error(`Failed: ${result.error}`, { id: toastId })
      }
    })
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      try {
        if (isEdit) {
          await updateConnection(editConnection.id, form)
          toast.success('Connection updated')
        } else {
          await createConnection(form)
          toast.success('Mailbox added')
        }
        onOpenChange(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Something went wrong')
      }
    })
  }

  const canTest = !!(form.smtpHost.trim() && form.smtpUser.trim() && form.smtpPass.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg overflow-y-auto max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit mailbox' : 'Add mailbox'}</DialogTitle>
        </DialogHeader>
        <form id="connection-form" onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="conn-label">Label</Label>
            <Input
              id="conn-label"
              placeholder="Work Gmail"
              value={form.label}
              onChange={(e) => set('label', e.target.value)}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="conn-fromName">From name</Label>
              <Input
                id="conn-fromName"
                placeholder="Jane Smith"
                value={form.fromName}
                onChange={(e) => set('fromName', e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="conn-fromEmail">From email</Label>
              <Input
                id="conn-fromEmail"
                type="email"
                placeholder="jane@domain.com"
                value={form.fromEmail}
                onChange={(e) => set('fromEmail', e.target.value)}
                required
              />
            </div>
          </div>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="conn-smtpHost">SMTP host</Label>
              <Input
                id="conn-smtpHost"
                placeholder="smtp.gmail.com"
                value={form.smtpHost}
                onChange={(e) => set('smtpHost', e.target.value)}
                required
              />
            </div>
            <div className="flex items-end gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="conn-smtpPort">Port</Label>
                <Input
                  id="conn-smtpPort"
                  type="number"
                  className="w-24"
                  value={form.smtpPort}
                  onChange={(e) => set('smtpPort', Number(e.target.value))}
                  required
                />
              </div>
              <div className="flex items-center gap-2 pb-2">
                <Switch
                  id="conn-smtpSecure"
                  checked={form.smtpSecure}
                  onCheckedChange={(val) => set('smtpSecure', val)}
                />
                <Label htmlFor="conn-smtpSecure" className="cursor-pointer font-normal">
                  TLS (port 465)
                </Label>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="conn-smtpUser">Username</Label>
              <Input
                id="conn-smtpUser"
                placeholder="jane@domain.com"
                value={form.smtpUser}
                onChange={(e) => set('smtpUser', e.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="conn-smtpPass">
                Password
                {isEdit && (
                  <span className="text-muted-foreground ml-1 text-xs font-normal">
                    leave blank to keep
                  </span>
                )}
              </Label>
              <Input
                id="conn-smtpPass"
                type="password"
                placeholder={isEdit ? '••••••••' : 'App password'}
                value={form.smtpPass}
                onChange={(e) => set('smtpPass', e.target.value)}
                required={!isEdit}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="conn-dailyLimit">Daily send limit</Label>
            <Input
              id="conn-dailyLimit"
              type="number"
              className="w-28"
              value={form.dailyLimit}
              onChange={(e) => set('dailyLimit', Number(e.target.value))}
              min={1}
              required
            />
          </div>

          {/* IMAP section */}
          <div className="border-t pt-3 grid gap-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium leading-none">IMAP / receive</p>
                <p className="text-muted-foreground mt-1 text-xs">Track replies and bounces</p>
              </div>
              <Switch
                id="conn-imapEnabled"
                checked={form.imapEnabled}
                onCheckedChange={(v) => set('imapEnabled', v)}
              />
            </div>

            {form.imapEnabled && (
              <>
                <div className="flex items-center gap-2">
                  <Switch
                    id="conn-imapSameAsSmtp"
                    checked={form.imapSameAsSmtp}
                    onCheckedChange={(v) => set('imapSameAsSmtp', v)}
                  />
                  <Label htmlFor="conn-imapSameAsSmtp" className="cursor-pointer font-normal">
                    Use same credentials as SMTP
                  </Label>
                </div>

                {!form.imapSameAsSmtp && (
                  <div className="grid gap-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="conn-imapHost">IMAP host</Label>
                      <Input
                        id="conn-imapHost"
                        placeholder="imap.gmail.com"
                        value={form.imapHost}
                        onChange={(e) => set('imapHost', e.target.value)}
                        required
                      />
                    </div>
                    <div className="flex items-end gap-3">
                      <div className="grid gap-1.5">
                        <Label htmlFor="conn-imapPort">Port</Label>
                        <Input
                          id="conn-imapPort"
                          type="number"
                          className="w-24"
                          value={form.imapPort}
                          onChange={(e) => set('imapPort', Number(e.target.value))}
                          required
                        />
                      </div>
                      <div className="flex items-center gap-2 pb-2">
                        <Switch
                          id="conn-imapSecure"
                          checked={form.imapSecure}
                          onCheckedChange={(v) => set('imapSecure', v)}
                        />
                        <Label htmlFor="conn-imapSecure" className="cursor-pointer font-normal">
                          TLS (port 993)
                        </Label>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label htmlFor="conn-imapUser">Username</Label>
                        <Input
                          id="conn-imapUser"
                          placeholder="jane@domain.com"
                          value={form.imapUser}
                          onChange={(e) => set('imapUser', e.target.value)}
                          required
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="conn-imapPass">
                          Password
                          {isEdit && (
                            <span className="text-muted-foreground ml-1 text-xs font-normal">
                              leave blank to keep
                            </span>
                          )}
                        </Label>
                        <Input
                          id="conn-imapPass"
                          type="password"
                          placeholder={isEdit ? '••••••••' : 'App password'}
                          value={form.imapPass}
                          onChange={(e) => set('imapPass', e.target.value)}
                          required={!isEdit}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </form>
        <DialogFooter showCloseButton>
          <Button
            type="button"
            variant="outline"
            disabled={!canTest || isTestPending || isPending}
            onClick={handleTest}
            title={!canTest ? 'Fill in SMTP host, username and password to test' : undefined}
          >
            {isTestPending ? (
              <IconLoader className="mr-1.5 size-4 animate-spin" />
            ) : (
              <IconWifi className="mr-1.5 size-4" />
            )}
            Test
          </Button>
          <Button type="submit" form="connection-form" disabled={isPending || isTestPending}>
            {isPending && <IconLoader className="mr-1.5 size-4 animate-spin" />}
            {isEdit ? 'Save changes' : 'Add mailbox'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type WarmupFormValues = {
  enabled: boolean
  startVolume: number
  dailyIncrease: number
  maxVolume: number
  replyRate: number
}

interface WarmupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connection: SafeConnection
}

/** Remounted (via `key`) each time it opens, so the form always starts from saved values. */
function WarmupDialog({ open, onOpenChange, connection }: WarmupDialogProps) {
  const warmup = connection.warmup
  const [form, setForm] = useState<WarmupFormValues>(() => ({
    enabled: warmup?.enabled ?? false,
    startVolume: warmup?.startVolume ?? 2,
    dailyIncrease: warmup?.dailyIncrease ?? 2,
    maxVolume: warmup?.maxVolume ?? 20,
    replyRate: warmup?.replyRate ?? 30,
  }))
  const [isPending, startTransition] = useTransition()

  function set<K extends keyof WarmupFormValues>(key: K, value: WarmupFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      try {
        await updateWarmupSettings(connection.id, form)
        toast.success('Warmup settings saved')
        onOpenChange(false)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Something went wrong')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Warmup · {connection.fromEmail}</DialogTitle>
        </DialogHeader>
        <form id={`warmup-form-${connection.id}`} onSubmit={handleSubmit} className="grid gap-4">
          <p className="text-muted-foreground text-xs">
            Warmup trades short, natural emails between your own mailboxes, moves any that land in
            spam back to the inbox and replies to some of them. Each warmup mailbox needs IMAP.
            Works best with 3+ mailboxes on different domains.
          </p>
          <div className="flex items-center justify-between">
            <Label htmlFor="warmup-enabled" className="cursor-pointer">
              Enable warmup
            </Label>
            <Switch
              id="warmup-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => set('enabled', v)}
            />
          </div>
          {warmup?.enabled && warmup.reason && (
            <p className="text-xs text-amber-400">{warmup.reason}</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="warmup-start">Start volume / day</Label>
              <Input
                id="warmup-start"
                type="number"
                min={1}
                value={form.startVolume}
                onChange={(e) => set('startVolume', Number(e.target.value))}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="warmup-increase">Daily increase</Label>
              <Input
                id="warmup-increase"
                type="number"
                min={0}
                value={form.dailyIncrease}
                onChange={(e) => set('dailyIncrease', Number(e.target.value))}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="warmup-max">Max volume / day</Label>
              <Input
                id="warmup-max"
                type="number"
                min={1}
                value={form.maxVolume}
                onChange={(e) => set('maxVolume', Number(e.target.value))}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="warmup-reply">Reply rate (%)</Label>
              <Input
                id="warmup-reply"
                type="number"
                min={0}
                max={100}
                value={form.replyRate}
                onChange={(e) => set('replyRate', Number(e.target.value))}
                required
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            Warmup has its own ramp and does not use this mailbox&apos;s campaign daily limit.
          </p>
        </form>
        <DialogFooter showCloseButton>
          <Button type="submit" form={`warmup-form-${connection.id}`} disabled={isPending}>
            {isPending && <IconLoader className="mr-1.5 size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RowActions({ connection }: { connection: SafeConnection }) {
  const [isPending, startTransition] = useTransition()
  const [editOpen, setEditOpen] = useState(false)
  const [warmupOpen, setWarmupOpen] = useState(false)
  const [warmupKey, setWarmupKey] = useState(0)

  function handleTest() {
    startTransition(async () => {
      const toastId = toast.loading('Testing connection…')
      const result = await testConnection(connection.id)
      if (result.ok) {
        toast.success('Connection verified', { id: toastId })
      } else {
        toast.error(`Failed: ${result.error}`, { id: toastId })
      }
    })
  }

  function handleToggle() {
    startTransition(async () => {
      await toggleConnectionStatus(connection.id, connection.status)
    })
  }

  function handleDelete() {
    startTransition(async () => {
      await deleteConnection(connection.id)
      toast.success('Mailbox removed')
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" disabled={isPending}>
            {isPending ? (
              <IconLoader className="size-4 animate-spin" />
            ) : (
              <IconDots className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={handleTest}>
            <IconWifi className="size-4" />
            Test connection
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>
            <IconPencil className="size-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setWarmupKey((k) => k + 1)
              setWarmupOpen(true)
            }}
          >
            <IconFlame className="size-4" />
            Warmup settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggle}>
            {connection.status === 'active' ? (
              <>
                <IconPlayerPause className="size-4" />
                Pause
              </>
            ) : (
              <>
                <IconPlayerPlay className="size-4" />
                Resume
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={handleDelete}>
            <IconTrash className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConnectionDialog open={editOpen} onOpenChange={setEditOpen} editConnection={connection} />
      <WarmupDialog
        key={warmupKey}
        open={warmupOpen}
        onOpenChange={setWarmupOpen}
        connection={connection}
      />
    </>
  )
}

export function ConnectionsView({ connections }: { connections: SafeConnection[] }) {
  const [addOpen, setAddOpen] = useState(false)
  const [isWarmupPending, startWarmupTransition] = useTransition()
  const anyWarmup = connections.some((c) => c.warmup?.enabled)

  function handleRunWarmup() {
    startWarmupTransition(async () => {
      const toastId = toast.loading('Running warmup…')
      const result = await triggerWarmup()
      if (result.ok) {
        toast.success(
          `Warmup ran: ${result.sent} sent, ${result.replied} replied, ${result.found} found in inboxes`,
          { id: toastId },
        )
      } else {
        toast.error(`Failed: ${result.error}`, { id: toastId })
      }
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Email Connections</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Connect SMTP mailboxes to send your campaigns.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {anyWarmup && (
            <Button variant="outline" className="gap-2" disabled={isWarmupPending} onClick={handleRunWarmup}>
              {isWarmupPending ? (
                <IconLoader className="size-4 animate-spin" />
              ) : (
                <IconFlame className="size-4" />
              )}
              Run warmup now
            </Button>
          )}
          <Button className="gap-2" onClick={() => setAddOpen(true)}>
            <IconMailPlus className="size-4" />
            Add mailbox
          </Button>
        </div>
      </div>

      {connections.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20">
            <div className="bg-primary/10 mb-4 flex size-14 items-center justify-center rounded-full">
              <IconPlugConnected className="text-primary size-7" />
            </div>
            <CardTitle className="mb-1 text-base">No mailboxes yet</CardTitle>
            <CardDescription className="max-w-xs text-center text-sm">
              Add your first SMTP mailbox to start sending. Supports Gmail, Outlook, and any custom
              SMTP provider.
            </CardDescription>
            <Button className="mt-6 gap-2" onClick={() => setAddOpen(true)}>
              <IconMailPlus className="size-4" />
              Add your first mailbox
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <TooltipProvider>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Label</TableHead>
                    <TableHead>Email address</TableHead>
                    <TableHead>DNS Records</TableHead>
                    <TableHead>Daily limit</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Warmup</TableHead>
                    <TableHead>Last tested</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((conn) => (
                    <TableRow key={conn.id}>
                      <TableCell className="font-medium">{conn.label}</TableCell>
                      <TableCell className="text-muted-foreground">{conn.fromEmail}</TableCell>
                      <TableCell>{dnsBadge(conn.dnsRecords)}</TableCell>
                      <TableCell>{conn.dailyLimit}</TableCell>
                      <TableCell>{statusBadge(conn.status)}</TableCell>
                      <TableCell>{warmupCell(conn.warmup)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatLastTested(conn.lastTestedAt)}
                      </TableCell>
                      <TableCell>
                        <RowActions connection={conn} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TooltipProvider>
          </CardContent>
        </Card>
      )}

      <ConnectionDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}
