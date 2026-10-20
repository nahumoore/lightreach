import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, leads } from '@workspace/db'
import { eq, and, asc } from 'drizzle-orm'
import {
  createLead,
  updateLead,
  deleteLead,
  importLeads,
  moveLeads,
} from '@/app/(dashboard)/leads/actions'
import { ok, err } from './shared'

const statusEnum = z.enum(['new', 'contacted', 'replied', 'bounced', 'unsubscribed'])

export function registerLeadsTools(server: McpServer) {
  server.tool(
    'list_leads',
    'List leads, optionally filtered by list or status',
    {
      listId: z.number().int().optional().describe('Filter by list ID'),
      status: statusEnum.optional().describe('Filter by lead status'),
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
    async ({ listId, status, limit, offset }) => {
      const rows = await db
        .select()
        .from(leads)
        .where(
          and(
            listId !== undefined ? eq(leads.listId, listId) : undefined,
            status !== undefined ? eq(leads.status, status) : undefined,
          ),
        )
        .orderBy(asc(leads.id))
        .limit(limit)
        .offset(offset)
      return ok(rows)
    },
  )

  server.tool(
    'get_lead',
    'Get a single lead by ID',
    { id: z.number().int().positive().describe('Lead ID') },
    async ({ id }) => {
      const [row] = await db.select().from(leads).where(eq(leads.id, id))
      if (!row) return err('Lead not found')
      return ok(row)
    },
  )

  server.tool(
    'create_lead',
    'Create a new lead in a list',
    {
      listId: z.number().int().positive().describe('List to add the lead to'),
      email: z.string().email().describe('Lead email address (must be unique within the list)'),
      firstName: z.string().optional().describe('First name'),
      lastName: z.string().optional().describe('Last name'),
      company: z.string().optional().describe('Company name'),
      openingLine: z.string().optional().describe('Custom opening line for personalization'),
      customFields: z
        .record(z.string(), z.string())
        .optional()
        .describe('Extra fields usable as {{variables}} in sequences'),
    },
    async (data) => {
      try {
        await createLead(data)
        return ok({ created: true })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'update_lead',
    'Update fields on an existing lead',
    {
      id: z.number().int().positive().describe('Lead ID to update'),
      email: z.string().email().optional().describe('New email address'),
      firstName: z.string().optional().describe('New first name'),
      lastName: z.string().optional().describe('New last name'),
      company: z.string().optional().describe('New company'),
      openingLine: z.string().optional().describe('New opening line'),
      status: statusEnum.optional().describe('New status'),
      customFields: z
        .record(z.string(), z.string())
        .optional()
        .describe('Custom fields to set; merged into the lead\'s existing custom fields'),
    },
    async ({ id, ...patch }) => {
      try {
        await updateLead(id, patch)
        return ok({ updated: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'delete_lead',
    'Delete a lead by ID',
    { id: z.number().int().positive().describe('Lead ID to delete') },
    async ({ id }) => {
      try {
        await deleteLead(id)
        return ok({ deleted: true, id })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'move_leads',
    'Move leads to another list. Leads whose email already exists in the target list are skipped',
    {
      leadIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(1000)
        .describe('IDs of the leads to move'),
      targetListId: z.number().int().positive().describe('List to move the leads into'),
    },
    async ({ leadIds, targetListId }) => {
      try {
        const result = await moveLeads(leadIds, targetListId)
        return ok(result)
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'import_leads',
    'Bulk-import leads into a list; duplicate emails are skipped',
    {
      listId: z.number().int().positive().describe('List ID to import into'),
      leads: z
        .array(
          z.object({
            email: z.string().email(),
            firstName: z.string().default(''),
            lastName: z.string().default(''),
            company: z.string().default(''),
            openingLine: z.string().default(''),
            customFields: z.record(z.string(), z.string()).default({}),
          }),
        )
        .describe('Array of lead records'),
    },
    async ({ listId, leads: rows }) => {
      try {
        const result = await importLeads(listId, rows)
        return ok(result)
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
