import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { API_KEY } from './server.js'
import { createServer } from './server.js'

if (!API_KEY) {
  process.stderr.write(
    'Error: DEWEY_API_KEY environment variable is required\n',
  )
  process.exit(1)
}

const server = createServer()
const transport = new StdioServerTransport()
await server.connect(transport)
