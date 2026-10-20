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
    'Update an existing connection. Only the fields you pass are changed; passwords are only replaced when provided',
    {
      id: z.number().int().positive().describe('Connection ID to update'),
      label: z.string().min(1).optional().describe('Display label for this mailbox'),
      fromName: z.string().min(1).optional().describe('Sender display name'),
      fromEmail: z.string().email().optional().describe('From email address'),
      smtpHost: z.string().min(1).optional().describe('SMTP server hostname'),
      smtpPort: z.number().int().min(1).max(65535).optional().describe('SMTP port'),
      smtpSecure: z
        .boolean()
        .optional()
        .describe('SSL/TLS (true) vs STARTTLS (false)'),
      smtpUser: z.string().min(1).optional().describe('SMTP username'),
      smtpPass: z.string().optional().describe('New SMTP password (omit to keep existing)'),
      dailyLimit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Max emails per day from this mailbox'),
      imapEnabled: z.boolean().optional().describe('Enable IMAP inbox polling'),
      imapSameAsSmtp: z
        .boolean()
        .optional()
        .describe('Use same host/credentials as SMTP for IMAP'),
      imapHost: z.string().optional().describe('IMAP hostname (only if imapSameAsSmtp=false)'),
      imapPort: z.number().int().optional().describe('IMAP port'),
      imapSecure: z.boolean().optional().describe('IMAP SSL/TLS'),
      imapUser: z.string().optional().describe('IMAP username (only if imapSameAsSmtp=false)'),
      imapPass: z
        .string()
        .optional()
        .describe('New IMAP password (only if imapSameAsSmtp=false, omit to keep existing)'),
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
    'Verify SMTP credentials for a saved connection, and IMAP too when IMAP is enabled. On success returns separate smtp and imap results (imap is null when disabled); on failure returns an error naming which check failed',
    { id: z.number().int().positive().describe('Connection ID to test') },
    async ({ id }) => {
      const result = await testConnection(id)
      if (!result.ok) {
        const detail = result.smtp
          ? ` (smtp: ${result.smtp.ok ? 'ok' : 'failed'}, imap: ${
              result.imap ? (result.imap.ok ? 'ok' : 'failed') : 'disabled'
            })`
          : ''
        return err(`${result.error ?? 'Connection test failed'}${detail}`)
      }
      return ok({ ok: true, smtp: result.smtp, imap: result.imap })
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
