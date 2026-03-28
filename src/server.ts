import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

// ── Config ──────────────────────────────────────────────────────────────────

export const API_KEY = process.env.DEWEY_API_KEY
export const API_URL = (
  process.env.DEWEY_API_URL ?? 'https://api.meetdewey.com/v1'
).replace(/\/$/, '')

export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}` }
}

export function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), 'Content-Type': 'application/json' }
}

export function collectionId(provided: string | undefined): string | null {
  return provided ?? process.env.DEWEY_COLLECTION_ID ?? null
}

export function missingCollection() {
  return {
    content: [
      {
        type: 'text' as const,
        text: 'collection_id is required when DEWEY_COLLECTION_ID is not set.',
      },
    ],
    isError: true,
  }
}

export async function httpError(res: Response) {
  const body = await res.text().catch(() => '')
  return {
    content: [
      { type: 'text' as const, text: `API error ${res.status}: ${body}` },
    ],
    isError: true,
  }
}

/** 10-second timeout for all API calls. Prevents the MCP tool from hanging
 *  when the Dewey API is slow or temporarily unavailable. */
export function timeout() {
  return AbortSignal.timeout(10_000)
}

// ── SSE stream consumer ──────────────────────────────────────────────────────

type SseEvent =
  | { type: 'scan'; sectionCount: number }
  | { type: 'tool_call'; query: string; tool?: string }
  | { type: 'chunk'; content: string }
  | {
      type: 'done'
      sessionId: string
      sources: Array<{
        chunkId: string
        filename: string
        sectionTitle: string
      }>
    }
  | { type: 'error'; message: string }

export async function consumeResearchStream(res: Response): Promise<
  | {
      ok: true
      answer: string
      sources: Array<{
        chunkId: string
        filename: string
        sectionTitle: string
      }>
    }
  | { ok: false; message: string }
> {
  if (!res.body) return { ok: false, message: 'Empty response body' }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const chunks: string[] = []
  let sources: Array<{
    chunkId: string
    filename: string
    sectionTitle: string
  }> = []

  try {
    outer: while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let event: SseEvent
        try {
          event = JSON.parse(line.slice(6)) as SseEvent
        } catch {
          continue
        }

        if (event.type === 'chunk') {
          chunks.push(event.content)
        } else if (event.type === 'done') {
          sources = event.sources
          break outer
        } else if (event.type === 'error') {
          return { ok: false, message: event.message }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  return { ok: true, answer: chunks.join(''), sources }
}

// ── Server factory ───────────────────────────────────────────────────────────

function fetchError(err: unknown) {
  const msg =
    err instanceof Error && err.name === 'TimeoutError'
      ? 'Request timed out — the Dewey API did not respond within 10 seconds.'
      : `Request failed: ${err instanceof Error ? err.message : String(err)}`
  return { content: [{ type: 'text' as const, text: msg }], isError: true }
}

export function createServer() {
  const server = new McpServer({
    name: 'dewey',
    version: '0.1.0',
  })

  // ── dewey_list_collections ──────────────────────────────────────────────────

  server.tool(
    'dewey_list_collections',
    'List all collections in the current Dewey project.',
    {},
    async () => {
      let res: Response
      try {
        res = await fetch(`${API_URL}/collections`, {
          headers: authHeaders(),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }

      if (!res.ok) return httpError(res)

      const collections = (await res.json()) as Array<{
        id: string
        name: string
        visibility: string
        embeddingModel: string
        documentCount?: number
      }>

      if (collections.length === 0) {
        return { content: [{ type: 'text', text: 'No collections found.' }] }
      }

      const text = collections
        .map((c) => `${c.name} [${c.visibility}] — ID: ${c.id}`)
        .join('\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_search ────────────────────────────────────────────────────────────

  server.tool(
    'dewey_search',
    'Hybrid semantic + keyword search over chunk content in a Dewey collection. Returns ranked chunks with section and document context.',
    {
      query: z.string().min(1).max(1000).describe('Search query'),
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID to search. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of chunks to return (1–50). Defaults to 10.'),
    },
    async ({ query, collection_id, limit }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      let res: Response
      try {
        res = await fetch(`${API_URL}/collections/${collId}/query`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ q: query, limit }),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }

      if (!res.ok) return httpError(res)

      const results = (await res.json()) as Array<{
        score: number
        chunk: {
          id: string
          content: string
          position: number
          tokenCount: number
        }
        section: { id: string; title: string; level: number }
        document: { id: string; filename: string }
      }>

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No results found.' }] }
      }

      const text = results
        .map(
          (r, i) =>
            `[${i + 1}] Score: ${r.score.toFixed(3)}\nDocument: ${r.document.filename}\nSection: ${r.section.title}\n\n${r.chunk.content}`,
        )
        .join('\n\n---\n\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_scan_sections ──────────────────────────────────────────────────────

  server.tool(
    'dewey_scan_sections',
    'Lightweight search over section titles and summaries in a Dewey collection. Faster than full chunk search — use to explore document structure and identify which sections to read before loading full content.',
    {
      query: z.string().min(1).max(1000).describe('Search query'),
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID to scan. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum sections to return (1–100). Defaults to 20.'),
    },
    async ({ query, collection_id, top_k }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      let res: Response
      try {
        res = await fetch(`${API_URL}/collections/${collId}/sections/scan`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ query, top_k }),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }

      if (!res.ok) return httpError(res)

      const { results } = (await res.json()) as {
        results: Array<{
          score: number
          section: {
            id: string
            title: string
            level: number
            summary: string | null
          }
          document: { id: string; filename: string }
        }>
      }

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No sections found.' }] }
      }

      const text = results
        .map((r, i) => {
          const summary = r.section.summary
            ? `\nSummary: ${r.section.summary}`
            : ''
          return `[${i + 1}] Score: ${r.score.toFixed(3)}\nDocument: ${r.document.filename}\nSection: ${r.section.title} (h${r.section.level})${summary}\nSection ID: ${r.section.id}`
        })
        .join('\n\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_research ──────────────────────────────────────────────────────────

  server.tool(
    'dewey_research',
    'Run a full agentic research query against a Dewey collection. The model searches, scans, and reads sections autonomously, then returns a grounded answer with citations.',
    {
      query: z.string().min(1).max(1000).describe('Research question'),
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID to research. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
      depth: z
        .enum(['quick', 'balanced', 'deep', 'exhaustive'])
        .optional()
        .describe(
          'Controls iteration budget and tool availability. quick=5 iters, balanced=10, deep=20, exhaustive=50. Defaults to "balanced". Note: deep and exhaustive require BYOK (OpenAI key configured in your project).',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'OpenAI model to use for the research loop. Defaults to "gpt-4o-mini".',
        ),
    },
    async ({ query, collection_id, depth, model }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      let res: Response
      try {
        res = await fetch(`${API_URL}/collections/${collId}/research`, {
          method: 'POST',
          headers: { ...jsonHeaders(), Accept: 'text/event-stream' },
          body: JSON.stringify({ q: query, depth, model }),
          signal: AbortSignal.timeout(120_000), // research can take up to 2 min
        })
      } catch (err) {
        return fetchError(err)
      }

      if (!res.ok) return httpError(res)

      const result = await consumeResearchStream(res)

      if (!result.ok) {
        return {
          content: [
            { type: 'text', text: `Research failed: ${result.message}` },
          ],
          isError: true,
        }
      }

      let text = result.answer
      if (result.sources.length > 0) {
        const sourceList = result.sources
          .map((s, i) => `[${i + 1}] ${s.filename} — ${s.sectionTitle}`)
          .join('\n')
        text += `\n\n**Sources:**\n${sourceList}`
      }

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_list_documents ────────────────────────────────────────────────────

  server.tool(
    'dewey_list_documents',
    'List documents in a Dewey collection with their processing status.',
    {
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
    },
    async ({ collection_id }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      let res: Response
      try {
        res = await fetch(`${API_URL}/collections/${collId}/documents`, {
          headers: authHeaders(),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }

      if (!res.ok) return httpError(res)

      const docs = (await res.json()) as Array<{
        id: string
        filename: string
        status: string
        fileSizeBytes: number
        errorMessage?: string
      }>

      if (docs.length === 0) {
        return {
          content: [{ type: 'text', text: 'No documents in this collection.' }],
        }
      }

      const text = docs
        .map((d) => {
          const error = d.errorMessage ? ` (${d.errorMessage})` : ''
          const size = (d.fileSizeBytes / 1024).toFixed(0)
          return `${d.filename} [${d.status}${error}] ${size} KB — ID: ${d.id}`
        })
        .join('\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_get_section ───────────────────────────────────────────────────────

  server.tool(
    'dewey_get_section',
    'Fetch the full Markdown content of a section by its ID. Use after dewey_scan_sections to read the content of a specific section.',
    {
      section_id: z.string().describe('Section ID to fetch'),
    },
    async ({ section_id }) => {
      let res: Response
      try {
        res = await fetch(`${API_URL}/sections/${section_id}`, {
          headers: authHeaders(),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }

      if (!res.ok) return httpError(res)

      const section = (await res.json()) as {
        id: string
        title: string
        level: number
        position: number
        documentId: string
        summary: string | null
        content: string | null
      }

      const header = [
        `# ${section.title}`,
        `Level: h${section.level} | Position: ${section.position} | Document ID: ${section.documentId}`,
        section.summary ? `Summary: ${section.summary}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      const text = `${header}\n\n${section.content ?? '(content not available)'}`

      return { content: [{ type: 'text', text }] }
    },
  )

  return server
}
