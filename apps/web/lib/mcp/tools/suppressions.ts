import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { db, leads, suppressions } from '@workspace/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  addSuppression,
  removeSuppression,
  importSuppressions,
  importSuppressionsCsv,
} from '@/app/(dashboard)/suppressions/actions'
import { findSuppressions, normalizeEmail, parseSuppressionValue } from '@/lib/suppression'
import { ok, err } from './shared'

const kindEnum = z.enum(['email', 'domain'])
const reasonEnum = z.enum(['unsubscribed', 'bounced', 'stop_reply', 'manual', 'import'])

export function registerSuppressionsTools(server: McpServer) {
  server.tool(
    'list_suppressions',
    'List suppressed emails and domains, optionally filtered by search text, type, or reason',
    {
      search: z.string().optional().describe('Only entries containing this text'),
      kind: kindEnum.optional().describe('Filter by entry type'),
      reason: reasonEnum.optional().describe('Filter by why it was suppressed'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe('Max records to return (default 100)'),
    },
    async ({ search, kind, reason, limit }) => {
      const q = search?.trim().toLowerCase()
      const rows = await db
        .select()
        .from(suppressions)
        .where(
          and(
            q ? sql`instr(${suppressions.value}, ${q}) > 0` : undefined,
            kind !== undefined ? eq(suppressions.kind, kind) : undefined,
            reason !== undefined ? eq(suppressions.reason, reason) : undefined,
          ),
        )
        .orderBy(desc(suppressions.createdAt), desc(suppressions.id))
        .limit(limit)
      return ok(rows)
    },
  )

  server.tool(
    'add_suppression',
    'Never email an address or a whole domain again. Use "jane@example.com" for one address or "@example.com" for everyone at a domain.',
    { value: z.string().min(1).describe('Email address, or a domain such as @example.com') },
    async ({ value }) => {
      try {
        const added = await addSuppression(value)
        return ok({ added: true, ...added })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'remove_suppression',
    'Remove an entry from the suppression list. Leads already marked bounced or unsubscribed keep that status; change it with update_lead if they should be emailed again.',
    {
      id: z.number().int().positive().optional().describe('Suppression ID'),
      value: z.string().optional().describe('Email address or domain, instead of the ID'),
    },
    async ({ id, value }) => {
      try {
        if ((id === undefined) === (value === undefined)) {
          return err('Provide exactly one of id or value')
        }

        let targetId = id
        if (targetId === undefined) {
          const parsed = parseSuppressionValue(value!)
          if (!parsed) return err('Not a valid email address or domain')
          const [row] = await db
            .select({ id: suppressions.id })
            .from(suppressions)
            .where(and(eq(suppressions.kind, parsed.kind), eq(suppressions.value, parsed.value)))
          if (!row) return err('Not on the suppression list')
          targetId = row.id
        }

        await removeSuppression(targetId)
        return ok({ removed: true, id: targetId })
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'import_suppressions',
    'Bulk-add suppressions from an array of emails/domains or from CSV text; duplicates and invalid entries are counted, not added',
    {
      values: z.array(z.string()).optional().describe('Emails and/or domains (e.g. "@example.com")'),
      csv: z
        .string()
        .optional()
        .describe('CSV text. Uses the email/address/domain/value column, else the first column.'),
    },
    async ({ values, csv }) => {
      try {
        if ((values === undefined) === (csv === undefined)) {
          return err('Provide exactly one of values or csv')
        }
        const result = values !== undefined ? await importSuppressions(values) : await importSuppressionsCsv(csv!)
        return ok(result)
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'check_suppression',
    'Check whether an address would be skipped: returns the matching suppression entries (the address itself or its domain) and the status of any leads with that address',
    {
      email: z.string().optional().describe('Email address to check'),
      leadId: z.number().int().positive().optional().describe('Lead ID, instead of an email'),
    },
    async ({ email, leadId }) => {
      if ((email === undefined) === (leadId === undefined)) {
        return err('Provide exactly one of email or leadId')
      }

      let address: string
      if (leadId !== undefined) {
        const [lead] = await db.select({ email: leads.email }).from(leads).where(eq(leads.id, leadId))
        if (!lead) return err('Lead not found')
        address = lead.email
      } else {
        address = email!
      }

      const matches = await findSuppressions(address)
      const matchingLeads = await db
        .select({ id: leads.id, listId: leads.listId, status: leads.status })
        .from(leads)
        .where(sql`lower(${leads.email}) = ${normalizeEmail(address)}`)

      return ok({
        email: normalizeEmail(address),
        suppressed: matches.length > 0,
        matches,
        leads: matchingLeads,
      })
    },
  )
}
