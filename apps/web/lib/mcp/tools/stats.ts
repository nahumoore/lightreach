import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sql, eq, and } from 'drizzle-orm'
import {
  db,
  lists,
  leads,
  sequences,
  campaigns,
  connections,
  messages,
  inboundEmails,
} from '@workspace/db'
import { ok } from './shared'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cnt(table: any): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(table)
  return Number(row?.n ?? 0)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cntWhere(table: any, condition: any): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(table).where(condition)
  return Number(row?.n ?? 0)
}

export function registerStatsTools(server: McpServer) {
  server.tool(
    'get_stats',
    'Get a quick overview of all entity counts: leads, campaigns, messages sent, unread inbox, etc.',
    {},
    async () => {
      const [
        listCount,
        leadCount,
        seqCount,
        campaignCount,
        connectionCount,
        msgTotal,
        msgSent,
        msgQueued,
        msgFailed,
        inbTotal,
        inbUnread,
      ] = await Promise.all([
        cnt(lists),
        cnt(leads),
        cnt(sequences),
        cnt(campaigns),
        cnt(connections),
        cnt(messages),
        cntWhere(messages, eq(messages.status, 'sent')),
        cntWhere(messages, eq(messages.status, 'queued')),
        cntWhere(messages, eq(messages.status, 'failed')),
        cntWhere(inboundEmails, eq(inboundEmails.isWarmup, false)),
        cntWhere(inboundEmails, and(eq(inboundEmails.isRead, false), eq(inboundEmails.isWarmup, false))),
      ])

      return ok({
        lists: listCount,
        leads: leadCount,
        sequences: seqCount,
        campaigns: campaignCount,
        connections: connectionCount,
        messages: {
          total: msgTotal,
          sent: msgSent,
          queued: msgQueued,
          failed: msgFailed,
        },
        inboundEmails: {
          total: inbTotal,
          unread: inbUnread,
        },
      })
    },
  )
}
