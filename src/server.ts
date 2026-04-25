import { registerTools } from '@meetdewey/mcp-core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export const API_KEY = process.env.DEWEY_API_KEY
export const API_URL = (
  process.env.DEWEY_API_URL ?? 'https://api.meetdewey.com/v1'
).replace(/\/$/, '')

export function createServer() {
  const server = new McpServer({
    name: 'dewey',
    version: '0.1.0',
  })

  // Resolve context per call so tests (and operators) can mutate
  // DEWEY_COLLECTION_ID between invocations and have handlers observe the
  // change. The hosted Phase 3 transport will provide its own context
  // factory that derives credentials from the OAuth bearer token.
  registerTools(server, () => ({
    apiKey: process.env.DEWEY_API_KEY ?? '',
    apiUrl: (
      process.env.DEWEY_API_URL ?? 'https://api.meetdewey.com/v1'
    ).replace(/\/$/, ''),
    defaultCollectionId: process.env.DEWEY_COLLECTION_ID,
  }))

  return server
}
