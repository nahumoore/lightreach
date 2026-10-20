import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, campaigns, campaignConnections } from '@workspace/db'
import { eq } from 'drizzle-orm'
import {
  createCampaign,
  updateCampaign,
  launchCampaign,
  pauseCampaign,
  resumeCampaign,
  deleteCampaign,
} from '@/app/(dashboard)/campaigns/actions'
import { ok, err } from './shared'

export function registerCampaignsTools(server: McpServer) {
  server.tool('list_campaigns', 'List all campaigns', {}, async () => {
    const rows = await db.select().from(campaigns)
    return ok(rows)
  })

  server.tool(
    'get_campaign',
    'Get a single campaign with its assigned mailbox IDs',
    { id: z.number().int().positive().describe('Campaign ID') },
    async ({ id }) => {
      const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id))
      if (!campaign) return err('Campaign not found')
      const conns = await db
        .select({ connectionId: campaignConnections.connectionId })
        .from(campaignConnections)
        .where(eq(campaignConnections.campaignId, id))
      return ok({ ...campaign, connectionIds: conns.map((c) => c.connectionId) })
    },
  )

  server.tool(
    'create_campaign',
    'Create a new campaign pairing a sequence with a lead list and mailboxes',
    {
      name: z.string().min(1).describe('Campaign name'),
      sequenceId: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe('Sequence ID to use (null to create a draft)'),
      listId: z
        .number()
        .int()
        .positive()
        .nullable()
        .describe('Lead list ID (null to create a draft)'),
      connectionIds: z
        .array(z.number().int().positive())
        .describe('Mailbox connection IDs to rotate across'),
      sendWindowStart: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default('09:00')
        .describe('Send window start time in HH:MM (24h)'),
      sendWindowEnd: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default('17:00')
        .describe('Send window end time in HH:MM (24h)'),
      timezone: z.string().default('UTC').describe('IANA timezone for the send window'),
      daysOfWeek: z
        .array(z.number().int().min(0).max(6))
        .default([1, 2, 3, 4, 5])
        .describe('Days to send on (0=Sun, 1=Mon … 6=Sat)'),
      dailyCap: z
        .number()
        .int()
        .min(1)
        .default(100)
        .describe('Max emails per day for this campaign'),
      minDelaySeconds: z
        .number()
        .int()
        .min(0)
        .default(60)
        .describe('Min seconds of jitter between sends'),
      maxDelaySeconds: z
        .number()
        .int()
        .min(0)
        .default(300)
        .describe('Max seconds of jitter between sends'),
    },
    async (data) => {
      try {
        const id = await createCampaign(data)
        return ok({ id, name: data.name })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'update_campaign',
    'Update a draft or paused campaign. Only the fields you pass are changed. The sequence and list can only be changed while the campaign is a draft; running campaigns must be paused first',
    {
      id: z.number().int().positive().describe('Campaign ID to update'),
      name: z.string().min(1).optional().describe('Campaign name'),
      sequenceId: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Sequence ID to use (draft campaigns only)'),
      listId: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Lead list ID (draft campaigns only)'),
      connectionIds: z
        .array(z.number().int().positive())
        .optional()
        .describe('Mailbox connection IDs to rotate across (replaces the current set)'),
      sendWindowStart: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional()
        .describe('Send window start time in HH:MM (24h)'),
      sendWindowEnd: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional()
        .describe('Send window end time in HH:MM (24h)'),
      timezone: z.string().optional().describe('IANA timezone for the send window'),
      daysOfWeek: z
        .array(z.number().int().min(0).max(6))
        .optional()
        .describe('Days to send on (0=Sun, 1=Mon … 6=Sat)'),
      dailyCap: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Max emails per day for this campaign'),
      minDelaySeconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Min seconds of jitter between sends'),
      maxDelaySeconds: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Max seconds of jitter between sends'),
    },
    async ({ id, ...data }) => {
      try {
        await updateCampaign(id, data)
        return ok({ updated: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'launch_campaign',
    'Launch a campaign: queues step-1 messages for all leads and sets status to running',
    { id: z.number().int().positive().describe('Campaign ID to launch') },
    async ({ id }) => {
      try {
        await launchCampaign(id)
        return ok({ launched: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'pause_campaign',
    'Pause a running campaign (queued messages are not deleted)',
    { id: z.number().int().positive().describe('Campaign ID to pause') },
    async ({ id }) => {
      try {
        await pauseCampaign(id)
        return ok({ paused: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'resume_campaign',
    'Resume a paused campaign',
    { id: z.number().int().positive().describe('Campaign ID to resume') },
    async ({ id }) => {
      try {
        await resumeCampaign(id)
        return ok({ resumed: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'delete_campaign',
    'Delete a campaign and all its queued messages',
    { id: z.number().int().positive().describe('Campaign ID to delete') },
    async ({ id }) => {
      try {
        await deleteCampaign(id)
        return ok({ deleted: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
