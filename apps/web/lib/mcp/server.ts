import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerListsTools } from './tools/lists'
import { registerLeadsTools } from './tools/leads'
import { registerSequencesTools } from './tools/sequences'
import { registerConnectionsTools } from './tools/connections'
import { registerCampaignsTools } from './tools/campaigns'
import { registerMessagesTools } from './tools/messages'
import { registerInboxTools } from './tools/inbox'
import { registerSettingsTools } from './tools/settings'
import { registerStatsTools } from './tools/stats'
import { registerHealthTools } from './tools/health'

/**
 * Build a fresh stateless McpServer with all Lightreach domain tools registered.
 * Called once per HTTP request in the /api/mcp route handler.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'lightreach',
    version: '1.0.0',
  })

  registerListsTools(server)
  registerLeadsTools(server)
  registerSequencesTools(server)
  registerConnectionsTools(server)
  registerCampaignsTools(server)
  registerMessagesTools(server)
  registerInboxTools(server)
  registerSettingsTools(server)
  registerStatsTools(server)
  registerHealthTools(server)

  return server
}
