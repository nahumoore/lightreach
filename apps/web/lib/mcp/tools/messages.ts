import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, messages } from '@workspace/db'
import { eq, and, asc } from 'drizzle-orm'
import { ok, err } from './shared'

export function registerMessagesTools(server: McpServer) {
  server.tool(
    'list_messages',
    'List send-queue messages, optionally filtered by campaign, lead, or status',
    {
      campaignId: z.number().int().optional().describe('Filter by campaign ID'),
      leadId: z.number().int().optional().describe('Filter by lead ID'),
      status: z
        .enum(['queued', 'sending', 'sent', 'failed', 'skipped'])
        .optional()
        .describe('Filter by delivery status'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe('Max records to return (default 100)'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Records to skip, for paging (default 0)'),
    },
    async ({ campaignId, leadId, status, limit, offset }) => {
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            campaignId !== undefined ? eq(messages.campaignId, campaignId) : undefined,
            leadId !== undefined ? eq(messages.leadId, leadId) : undefined,
            status !== undefined ? eq(messages.status, status) : undefined,
          ),
        )
        .orderBy(asc(messages.id))
        .limit(limit)
        .offset(offset)
      return ok(rows)
    },
  )

  server.tool(
    'get_message',
    'Get a single message (sent or queued) by ID',
    { id: z.number().int().positive().describe('Message ID') },
    async ({ id }) => {
      const [row] = await db.select().from(messages).where(eq(messages.id, id))
      if (!row) return err('Message not found')
      return ok(row)
    },
  )
}
