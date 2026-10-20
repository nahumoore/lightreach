import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, connections } from '@workspace/db'
import { eq } from 'drizzle-orm'
import {
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  toggleConnectionStatus,
  sendTestEmail,
} from '@/app/(dashboard)/connections/actions'
import { redactConnection } from '../redact'
import { ok, err } from './shared'

const connectionBase = {
  label: z.string().min(1).describe('Display label for this mailbox'),
  fromName: z.string().min(1).describe('Sender display name'),
  fromEmail: z.string().email().describe('From email address'),
  smtpHost: z.string().min(1).describe('SMTP server hostname'),
  smtpPort: z.number().int().min(1).max(65535).default(587).describe('SMTP port (default 587)'),
  smtpSecure: z
    .boolean()
    .default(false)
    .describe('SSL/TLS (true) vs STARTTLS (false, default)'),
  smtpUser: z.string().min(1).describe('SMTP username'),
  dailyLimit: z
    .number()
    .int()
    .min(1)
    .default(50)
    .describe('Max emails per day from this mailbox'),
  imapEnabled: z.boolean().default(false).describe('Enable IMAP inbox polling'),
  imapSameAsSmtp: z
    .boolean()
    .default(true)
    .describe('Use same host/credentials as SMTP for IMAP'),
  imapHost: z.string().default('').describe('IMAP hostname (only if imapSameAsSmtp=false)'),
  imapPort: z.number().int().default(993).describe('IMAP port (default 993)'),
  imapSecure: z.boolean().default(true).describe('IMAP SSL/TLS'),
  imapUser: z.string().default('').describe('IMAP username (only if imapSameAsSmtp=false)'),
}

export function registerConnectionsTools(server: McpServer) {
  server.tool(
    'list_connections',
    'List all SMTP/IMAP mailbox connections (credentials are redacted)',
    {},
    async () => {
      const rows = await db.select().from(connections)
      return ok(rows.map(redactConnection))
    },
  )

  server.tool(
    'get_connection',
    'Get a single connection by ID (credentials redacted)',
    { id: z.number().int().positive().describe('Connection ID') },
    async ({ id }) => {
      const [row] = await db.select().from(connections).where(eq(connections.id, id))
      if (!row) return err('Connection not found')
      return ok(redactConnection(row))
    },
  )

  server.tool(
    'create_connection',
    'Create a new SMTP/IMAP mailbox connection',
    {
      ...connectionBase,
      smtpPass: z.string().min(1).describe('SMTP password (write-only, never returned)'),
      imapPass: z
        .string()
        .default('')
        .describe('IMAP password (only if imapSameAsSmtp=false, write-only)'),
    },
    async (data) => {
      try {
        await createConnection(data)
        return ok({ created: true })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'update_connection',
    'Update an existing connection — leave smtpPass/imapPass empty to keep current passwords',
    {
      id: z.number().int().positive().describe('Connection ID to update'),
      ...connectionBase,
      smtpPass: z
        .string()
        .default('')
        .describe('New SMTP password (leave empty to keep existing)'),
      imapPass: z
        .string()
        .default('')
        .describe('New IMAP password (leave empty to keep existing)'),
    },
    async ({ id, ...data }) => {
      try {
        await updateConnection(id, data)
        return ok({ updated: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'delete_connection',
    'Delete a mailbox connection',
    { id: z.number().int().positive().describe('Connection ID to delete') },
    async ({ id }) => {
      try {
        await deleteConnection(id)
        return ok({ deleted: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'test_connection',
    'Verify SMTP credentials for a saved connection',
    { id: z.number().int().positive().describe('Connection ID to test') },
    async ({ id }) => {
      const result = await testConnection(id)
      if (!result.ok) return err(result.error ?? 'Connection test failed')
      return result.autoPaused
        ? ok({
            ok: true,
            note: 'Credentials work, but the mailbox is still auto-paused by the health check. Resume it with toggle_connection_status.',
          })
        : ok({ ok: true })
    },
  )

  server.tool(
    'toggle_connection_status',
    'Toggle a connection between active and paused',
    {
      id: z.number().int().positive().describe('Connection ID'),
      currentStatus: z
        .enum(['active', 'paused', 'error'])
        .describe('The current status of the connection'),
    },
    async ({ id, currentStatus }) => {
      try {
        await toggleConnectionStatus(id, currentStatus)
        return ok({ id, newStatus: currentStatus === 'active' ? 'paused' : 'active' })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'send_test_email',
    'Send a test email through a saved connection to verify end-to-end delivery',
    {
      connectionId: z.number().int().positive().describe('Connection ID to send from'),
      to: z.string().email().describe('Recipient email address'),
      subject: z
        .string()
        .optional()
        .describe('Email subject (default: "Test email from Lightreach")'),
      body: z.string().optional().describe('Email body text'),
    },
    async ({ connectionId, to, subject, body }) => {
      const result = await sendTestEmail(connectionId, to, subject, body)
      return result.ok
        ? ok({ ok: true, messageId: result.messageId })
        : err(result.error ?? 'Failed to send test email')
    },
  )
}
