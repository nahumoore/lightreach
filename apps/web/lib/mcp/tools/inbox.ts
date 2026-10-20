import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, inboundEmails } from '@workspace/db'
import { eq, and, desc, isNotNull } from 'drizzle-orm'
import {
  markRead,
  markUnread,
  markThreadRead,
  replyToEmail,
  categorizeEmail,
  setLeadLabel,
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
    'List received inbound emails, newest first, optionally filtered by mailbox, campaign, lead, category, read status or replies only',
    {
      connectionId: z.number().int().positive().optional().describe('Filter by the mailbox that received it'),
      campaignId: z.number().int().positive().optional().describe('Filter by the campaign the sender was contacted through'),
      leadId: z.number().int().positive().optional().describe('Filter by the lead the email was matched to'),
      category: categoryEnum.optional().describe('Filter by category'),
      isRead: z.boolean().optional().describe('Filter by read status (true = read, false = unread)'),
      repliesOnly: z
        .boolean()
        .default(false)
        .describe('Only real replies: emails matched to a lead we contacted, excluding out-of-office auto-replies (default false)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('Max records to return (default 50)'),
      offset: z.number().int().min(0).default(0).describe('Records to skip, for paging (default 0)'),
    },
    async ({ connectionId, campaignId, leadId, category, isRead, repliesOnly, limit, offset }) => {
      const rows = await db
        .select()
        .from(inboundEmails)
        .where(
          and(
            eq(inboundEmails.isDuplicate, false),
            connectionId !== undefined ? eq(inboundEmails.connectionId, connectionId) : undefined,
            campaignId !== undefined ? eq(inboundEmails.campaignId, campaignId) : undefined,
            leadId !== undefined ? eq(inboundEmails.leadId, leadId) : undefined,
            category !== undefined ? eq(inboundEmails.category, category) : undefined,
            isRead !== undefined ? eq(inboundEmails.isRead, isRead) : undefined,
            repliesOnly ? and(isNotNull(inboundEmails.leadId), eq(inboundEmails.isAutoReply, false)) : undefined,
          ),
        )
        .orderBy(desc(inboundEmails.receivedAt), desc(inboundEmails.id))
        .limit(limit)
        .offset(offset)
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
    'Get the full two-way conversation history (inbound replies and outbound sends, chronologically ordered) for the lead an inbound email is linked to',
    { inboundId: z.number().int().positive().describe('Inbound email ID') },
    async ({ inboundId }) => {
      // The HTML body is for the web UI; text is enough (and much smaller) for tool callers.
      const msgs = await getFullThread(inboundId)
      return ok(msgs.map((m) => ({ ...m, bodyHtml: undefined })))
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
    'set_lead_label',
    'Set the category label on every inbound email from a lead (use categorize_email for a single email)',
    {
      leadId: z.number().int().positive().describe('Lead ID'),
      category: categoryEnum.describe('Category to assign'),
    },
    async ({ leadId, category }) => {
      try {
        const updated = await setLeadLabel(leadId, category)
        return updated > 0 ? ok({ updated, leadId, category }) : err('No inbound emails found for that lead')
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
    'mark_thread_read',
    'Mark every inbound email in the same conversation as an inbound email as read',
    { inboundId: z.number().int().positive().describe('Inbound email ID') },
    async ({ inboundId }) => {
      try {
        const ids = await markThreadRead(inboundId)
        return ids.length > 0 ? ok({ updated: ids.length, ids }) : err('Inbound email not found')
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
