'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { generateMcpToken, revealMcpToken, revokeMcpToken } from './actions'
import { Button } from '@workspace/ui/components/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card'
import { Badge } from '@workspace/ui/components/badge'
import {
  IconRefresh,
  IconEye,
  IconEyeOff,
  IconCopy,
  IconTrash,
  IconCheck,
} from '@tabler/icons-react'

// ---------------------------------------------------------------------------
// Tool catalog — static documentation shown in the "Tool Reference" section
// ---------------------------------------------------------------------------

type ToolEntry = { name: string; description: string; params: string }

const TOOL_GROUPS: { group: string; tools: ToolEntry[] }[] = [
  {
    group: 'Lists',
    tools: [
      { name: 'list_lists', description: 'List all lead lists', params: '—' },
      { name: 'create_list', description: 'Create a new lead list', params: 'name' },
      { name: 'rename_list', description: 'Rename a lead list', params: 'id, name' },
      { name: 'delete_list', description: 'Delete a list and all its leads', params: 'id' },
    ],
  },
  {
    group: 'Leads',
    tools: [
      {
        name: 'list_leads',
        description: 'List leads (filterable)',
        params: 'listId?, status?, limit?, offset?',
      },
      { name: 'get_lead', description: 'Get a single lead by ID', params: 'id' },
      {
        name: 'create_lead',
        description: 'Create a new lead in a list',
        params: 'listId, email, firstName?, lastName?, company?, openingLine?, customFields?',
      },
      {
        name: 'update_lead',
        description: 'Update lead fields',
        params: 'id, email?, firstName?, lastName?, company?, openingLine?, status?, customFields?',
      },
      { name: 'delete_lead', description: 'Delete a lead by ID', params: 'id' },
      {
        name: 'move_leads',
        description: 'Move leads to another list, skipping duplicate emails',
        params: 'leadIds[], targetListId',
      },
      {
        name: 'import_leads',
        description: 'Bulk-import leads, skipping duplicates',
        params: 'listId, leads[]',
      },
    ],
  },
  {
    group: 'Sequences',
    tools: [
      { name: 'list_sequences', description: 'List all email sequences', params: '—' },
      {
        name: 'get_sequence',
        description: 'Get sequence with all steps',
        params: 'id',
      },
      {
        name: 'create_sequence',
        description: 'Create a sequence with steps',
        params: 'name, steps[]',
      },
      {
        name: 'update_sequence',
        description: 'Replace all steps in a sequence',
        params: 'id, name, steps[]',
      },
      { name: 'delete_sequence', description: 'Delete a sequence', params: 'id' },
      {
        name: 'preview_step',
        description: 'Preview step with spintax expanded and variables substituted',
        params: 'subject, body, variables?',
      },
    ],
  },
  {
    group: 'Connections',
    tools: [
      {
        name: 'list_connections',
        description: 'List mailboxes (credentials redacted)',
        params: '—',
      },
      { name: 'get_connection', description: 'Get connection by ID (redacted)', params: 'id' },
      {
        name: 'create_connection',
        description: 'Create SMTP/IMAP mailbox',
        params: 'label, fromName, fromEmail, smtpHost, smtpPort, smtpUser, smtpPass, …',
      },
      {
        name: 'update_connection',
        description: 'Partial update: only passed fields change',
        params: 'id, …any create field…',
      },
      { name: 'delete_connection', description: 'Delete a mailbox', params: 'id' },
      {
        name: 'test_connection',
        description: 'Verify SMTP, and IMAP when enabled',
        params: 'id',
      },
      {
        name: 'toggle_connection_status',
        description: 'Toggle active ↔ paused',
        params: 'id, currentStatus',
      },
      {
        name: 'send_test_email',
        description: 'Send a test email through a saved connection',
        params: 'connectionId, to, subject?, body?',
      },
    ],
  },
  {
    group: 'Campaigns',
    tools: [
      { name: 'list_campaigns', description: 'List all campaigns', params: '—' },
      {
        name: 'get_campaign',
        description: 'Get campaign with assigned mailbox IDs',
        params: 'id',
      },
      {
        name: 'create_campaign',
        description: 'Create campaign (sequence + list + mailboxes + schedule)',
        params: 'name, sequenceId, listId, connectionIds[], sendWindow…',
      },
      {
        name: 'update_campaign',
        description: 'Edit a draft or paused campaign (partial update)',
        params: 'id, name?, sequenceId?, listId?, connectionIds?, sendWindow…',
      },
      {
        name: 'launch_campaign',
        description: 'Queue step-1 messages and set status to running',
        params: 'id',
      },
      { name: 'pause_campaign', description: 'Pause a running campaign', params: 'id' },
      { name: 'resume_campaign', description: 'Resume a paused campaign', params: 'id' },
      { name: 'delete_campaign', description: 'Delete a campaign', params: 'id' },
    ],
  },
  {
    group: 'Messages',
    tools: [
      {
        name: 'list_messages',
        description: 'List send-queue messages (filterable)',
        params: 'campaignId?, leadId?, status?, limit?, offset?',
      },
      { name: 'get_message', description: 'Get a single message by ID', params: 'id' },
    ],
  },
  {
    group: 'Inbox & Replies',
    tools: [
      {
        name: 'list_inbound_emails',
        description: 'List received emails (filterable)',
        params: 'category?, isRead?, limit?',
      },
      {
        name: 'get_inbound_email',
        description: 'Get inbound email with full body',
        params: 'id',
      },
      {
        name: 'get_thread',
        description: 'Get outbound history for a conversation',
        params: 'inboundId',
      },
      {
        name: 'reply_to_email',
        description: 'Reply to an inbound email',
        params: 'inboundId, body',
      },
      {
        name: 'categorize_email',
        description: 'Set category on an inbound email',
        params: 'id, category',
      },
      { name: 'mark_read', description: 'Mark email as read', params: 'id' },
      { name: 'mark_unread', description: 'Mark email as unread', params: 'id' },
      { name: 'trigger_fetch', description: 'Manually poll all IMAP inboxes', params: '—' },
    ],
  },
  {
    group: 'Settings & Stats',
    tools: [
      { name: 'get_settings', description: 'Get all app settings', params: '—' },
      {
        name: 'set_filter_keywords',
        description: 'Set inbox filter keywords',
        params: 'keywords',
      },
      {
        name: 'get_stats',
        description: 'Overview counts: leads, messages sent, unread inbox…',
        params: '—',
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function McpView({ hasToken }: { hasToken: boolean }) {
  const [token, setToken] = useState<string | null>(null)
  const [tokenExists, setTokenExists] = useState(hasToken)
  const [showing, setShowing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isPending, startTransition] = useTransition()

  const endpoint =
    typeof window !== 'undefined'
      ? `${window.location.protocol}//${window.location.host}/api/mcp`
      : 'http://localhost:3000/api/mcp'

  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        lightreach: {
          url: endpoint,
          headers: {
            Authorization: `Bearer ${token ?? '<your-bearer-token>'}`,
          },
        },
      },
    },
    null,
    2,
  )

  function handleGenerate() {
    startTransition(async () => {
      try {
        const t = await generateMcpToken()
        setToken(t)
        setTokenExists(true)
        setShowing(true)
        toast.success('Token generated')
      } catch {
        toast.error('Failed to generate token')
      }
    })
  }

  function handleReveal() {
    if (showing) {
      setShowing(false)
      return
    }
    startTransition(async () => {
      try {
        const t = await revealMcpToken()
        if (!t) {
          toast.error('No token found')
          return
        }
        setToken(t)
        setShowing(true)
      } catch {
        toast.error('Failed to reveal token')
      }
    })
  }

  function handleRevoke() {
    startTransition(async () => {
      try {
        await revokeMcpToken()
        setToken(null)
        setTokenExists(false)
        setShowing(false)
        toast.success('Token revoked')
      } catch {
        toast.error('Failed to revoke token')
      }
    })
  }

  function handleCopy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold">MCP Server</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect any MCP-compatible AI agent to Lightreach for full data access — create
          leads, launch campaigns, reply to emails, and more.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Access Token ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">API Token</CardTitle>
              <Badge variant={tokenExists ? 'default' : 'secondary'}>
                {tokenExists ? 'Active' : 'Not configured'}
              </Badge>
            </div>
            <CardDescription>
              Bearer token for MCP authentication. Keep it secret — anyone with this token
              can fully control Lightreach via the agent.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Token display */}
            {tokenExists && (
              <div className="bg-muted flex items-center gap-2 rounded-md p-2">
                <code className="flex-1 truncate text-xs">
                  {showing && token ? token : '••••••••••••••••••••••••••••••••••••••••'}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  onClick={handleReveal}
                  disabled={isPending}
                  aria-label={showing ? 'Hide token' : 'Reveal token'}
                >
                  {showing ? <IconEyeOff className="size-3.5" /> : <IconEye className="size-3.5" />}
                </Button>
                {showing && token && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    onClick={() => handleCopy(token)}
                    aria-label="Copy token"
                  >
                    {copied ? (
                      <IconCheck className="size-3.5 text-green-500" />
                    ) : (
                      <IconCopy className="size-3.5" />
                    )}
                  </Button>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={handleGenerate} disabled={isPending}>
                <IconRefresh className="size-3.5" />
                {tokenExists ? 'Rotate token' : 'Generate token'}
              </Button>
              {tokenExists && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleRevoke}
                  disabled={isPending}
                >
                  <IconTrash className="size-3.5" />
                  Revoke
                </Button>
              )}
            </div>

            <p className="text-muted-foreground text-xs">
              Rotating creates a new token and immediately invalidates the old one. Any
              agent configs must be updated with the new token.
            </p>
          </CardContent>
        </Card>

        {/* ── Connect your agent ───────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect Your Agent</CardTitle>
            <CardDescription>
              Add this to your project&apos;s <code className="text-xs">.mcp.json</code> (Claude
              Code) or <code className="text-xs">claude_desktop_config.json</code> (Claude
              Desktop).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
                {mcpJson}
              </pre>
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-2 size-7"
                onClick={() => handleCopy(mcpJson)}
                aria-label="Copy config snippet"
              >
                {copied ? (
                  <IconCheck className="size-3.5 text-green-500" />
                ) : (
                  <IconCopy className="size-3.5" />
                )}
              </Button>
            </div>
            {!token && (
              <p className="text-muted-foreground text-xs">
                Generate a token above to populate the snippet with your actual bearer
                token.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Tool Reference ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tool Reference</CardTitle>
          <CardDescription>
            All {TOOL_GROUPS.reduce((a, g) => a + g.tools.length, 0)} MCP tools exposed to
            your agent, grouped by domain.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {TOOL_GROUPS.map(({ group, tools }) => (
              <div key={group}>
                <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wider">
                  {group}
                </h3>
                <div className="border-border rounded-md border">
                  {tools.map((tool, idx) => (
                    <div
                      key={tool.name}
                      className={`flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-start sm:gap-4 ${
                        idx < tools.length - 1 ? 'border-b' : ''
                      }`}
                    >
                      <code className="text-primary w-56 shrink-0 text-xs font-medium">
                        {tool.name}
                      </code>
                      <span className="text-foreground flex-1 text-xs">{tool.description}</span>
                      <span className="text-muted-foreground w-64 shrink-0 text-right text-xs">
                        {tool.params}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
