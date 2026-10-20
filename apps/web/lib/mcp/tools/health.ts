import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { computeMailboxHealth, getHealthSettings, runHealthCheck } from '@/lib/health'
import { saveHealthSettings } from '@/app/(dashboard)/settings/actions'
import { ok, err } from './shared'

export function registerHealthTools(server: McpServer) {
  server.tool(
    'get_mailbox_health',
    'Get bounce rate, sends, DNS status and consecutive failures per mailbox over the health window, plus the current thresholds',
    {
      connectionId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Only this connection (default: all mailboxes)'),
    },
    async ({ connectionId }) => {
      const settings = await getHealthSettings()
      const mailboxes = await computeMailboxHealth({ connectionId, settings })
      if (connectionId !== undefined && mailboxes.length === 0) return err('Connection not found')
      return ok({ settings, mailboxes })
    },
  )

  server.tool(
    'set_health_settings',
    'Update mailbox health settings. Only the fields you pass are changed.',
    {
      threshold: z
        .number()
        .gt(0)
        .max(100)
        .optional()
        .describe('Bounce rate (percent) at or above which a mailbox is auto-paused (default 5)'),
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe('Days the bounce rate is measured over (default 7)'),
      minSends: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Minimum sends in the window before a mailbox can be paused (default 20)'),
      autoPause: z.boolean().optional().describe('Pause mailboxes automatically (default true)'),
    },
    async ({ threshold, windowDays, minSends, autoPause }) => {
      try {
        const settings = await saveHealthSettings({
          bounceThreshold: threshold,
          windowDays,
          minSends,
          autoPause,
        })
        return ok(settings)
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )

  server.tool(
    'run_health_check',
    'Run the mailbox health check now and pause any active mailbox at or above the bounce threshold. Returns the mailboxes it paused.',
    {},
    async () => {
      try {
        return ok(await runHealthCheck())
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  )
}
