import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, inboundEmails } from '@workspace/db'
import { eq, and } from 'drizzle-orm'
import {
  markRead,
  markUnread,
  replyToEmail,
  categorizeEmail,
  triggerFetch,
  getFullThread,
} from '@/app/(dashboard)/inbox/actions'
import { ok, err } from './shared'

const categoryEnum = z.enum([
  'none',
  'interested',
  'not_interested',
  'meeting_booked',
  'out_of_office',
  'do_not_contact',
])

export function registerInboxTools(server: McpServer) {
  server.tool(
    'list_inbound_emails',
    'List received inbound emails, optionally filtered by category or read status',
    {
      category: categoryEnum.optional().describe('Filter by category'),
      isRead: z.boolean().optional().describe('Filter by read status (true = read, false = unread)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('Max records to return (default 50)'),
    },
    async ({ category, isRead, limit }) => {
      const rows = await db
        .select()
        .from(inboundEmails)
        .where(
          and(
            eq(inboundEmails.isDuplicate, false),
            eq(inboundEmails.isWarmup, false),
            category !== undefined ? eq(inboundEmails.category, category) : undefined,
            isRead !== undefined ? eq(inboundEmails.isRead, isRead) : undefined,
          ),
        )
        .limit(limit)
      return ok(rows)
    },
  )

  server.tool(
    'get_inbound_email',
    'Get a single inbound email by ID (includes full body)',
    { id: z.number().int().positive().describe('Inbound email ID') },
    async ({ id }) => {
      const [row] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id))
      if (!row) return err('Inbound email not found')
      return ok(row)
    },
  )

  server.tool(
    'get_thread',
    'Get the full two-way conversation history (inbound replies and outbound sends, chronologically ordered) for a thread linked to an inbound email',
    { inboundId: z.number().int().positive().describe('Inbound email ID') },
    async ({ inboundId }) => {
      const msgs = await getFullThread(inboundId)
      return ok(msgs)
    },
  )

  server.tool(
    'reply_to_email',
    'Send a reply to an inbound email using the same mailbox it arrived on',
    {
      inboundId: z.number().int().positive().describe('Inbound email ID to reply to'),
      body: z.string().min(1).describe('Reply body text (plain text; line breaks become <br>)'),
    },
    async ({ inboundId, body }) => {
      const result = await replyToEmail(inboundId, body)
      return result.ok ? ok({ replied: true }) : err(result.error ?? 'Reply failed')
    },
  )

  server.tool(
    'categorize_email',
    'Set the category label on an inbound email',
    {
      id: z.number().int().positive().describe('Inbound email ID'),
      category: categoryEnum.describe('Category to assign'),
    },
    async ({ id, category }) => {
      try {
        await categorizeEmail(id, category)
        return ok({ updated: true, id, category })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'mark_read',
    'Mark an inbound email as read',
    { id: z.number().int().positive().describe('Inbound email ID') },
    async ({ id }) => {
      try {
        await markRead(id)
        return ok({ updated: true })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'mark_unread',
    'Mark an inbound email as unread',
    { id: z.number().int().positive().describe('Inbound email ID') },
    async ({ id }) => {
      try {
        await markUnread(id)
        return ok({ updated: true })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'trigger_fetch',
    'Manually trigger an IMAP inbox poll across all active connections',
    {},
    async () => {
      const result = await triggerFetch()
      return result.ok ? ok({ fetched: true }) : err(result.error ?? 'Inbox poll failed')
    },
  )
}
