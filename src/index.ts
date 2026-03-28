// Set system CA certs before any TLS operations so fetch() can verify certificates
// on systems where Node.js doesn't use the OS certificate store (e.g. Homebrew node on macOS).
// NODE_EXTRA_CA_CERTS must be set before TLS contexts are created, so this runs first.
import { existsSync } from 'node:fs'

if (!process.env.NODE_EXTRA_CA_CERTS) {
  for (const p of [
    '/etc/ssl/cert.pem', // macOS
    '/etc/ssl/certs/ca-certificates.crt', // Debian/Ubuntu
    '/etc/pki/tls/certs/ca-bundle.crt', // RHEL/CentOS/Fedora
  ]) {
    if (existsSync(p)) {
      process.env.NODE_EXTRA_CA_CERTS = p
      break
    }
  }
}

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
