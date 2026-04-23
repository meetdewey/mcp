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

// ── SSE stream consumers ─────────────────────────────────────────────────────

type ClaimMapItem = {
  id: string
  text: string
  sourceText?: string
  documentId: string
  documentName: string
  sectionId: string
  sectionTitle: string
  importance: number
  x: number
  y: number
}

type ClaimSseEvent =
  | { type: 'progress'; pct: number }
  | { type: 'done'; total: number; claims: ClaimMapItem[] }
  | { type: 'error'; message: string }

export async function consumeClaimsStream(
  res: Response,
): Promise<
  | { ok: true; total: number; claims: ClaimMapItem[] }
  | { ok: false; message: string }
> {
  if (!res.body) return { ok: false, message: 'Empty response body' }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let event: ClaimSseEvent
        try {
          event = JSON.parse(line.slice(6)) as ClaimSseEvent
        } catch {
          continue
        }

        if (event.type === 'done') {
          return { ok: true, total: event.total, claims: event.claims }
        }
        if (event.type === 'error') {
          return { ok: false, message: event.message }
        }
        // 'progress' events are ignored in MCP context
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  return { ok: false, message: 'Stream ended without a done event' }
}

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
  if (err instanceof Error && err.name === 'TimeoutError') {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Request timed out — the Dewey API did not respond within 10 seconds.',
        },
      ],
      isError: true,
    }
  }
  const cause =
    err instanceof Error && err.cause instanceof Error
      ? ` (${err.cause.message})`
      : ''
  const msg = `Request failed: ${err instanceof Error ? err.message : String(err)}${cause}`
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
        description?: string | null
        instructions?: string | null
      }>

      if (collections.length === 0) {
        return { content: [{ type: 'text', text: 'No collections found.' }] }
      }

      const text = collections
        .map((c) => {
          let line = `${c.name} [${c.visibility}] — ID: ${c.id}`
          if (c.description) line += `\n  Description: ${c.description}`
          if (c.instructions) line += `\n  Instructions: ${c.instructions}`
          return line
        })
        .join('\n\n')

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
          'OpenAI model to use for the research loop. Defaults to "gpt-4o-mini" for quick/balanced and "gpt-5.4" for deep/exhaustive.',
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

  // ── dewey_list_claims ───────────────────────────────────────────────────────

  server.tool(
    'dewey_list_claims',
    'List factual claims extracted from documents in a Dewey collection or a specific document. Claims are scored by importance (1=low, 5=critical). Use min_importance to focus on the most significant claims.',
    {
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID. Required if DEWEY_COLLECTION_ID env var is not set and document_id is not provided.',
        ),
      document_id: z
        .string()
        .optional()
        .describe(
          'Scope claims to a specific document ID. When provided, collection_id is not required.',
        ),
      min_importance: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe('Minimum importance score (1–5). Defaults to 3.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Maximum number of claims to return. Defaults to 50.'),
    },
    async ({ collection_id, document_id, min_importance = 3, limit = 50 }) => {
      if (document_id) {
        // Per-document endpoint — regular JSON, fast
        let res: Response
        try {
          res = await fetch(
            `${API_URL}/documents/${document_id}/claims?minImportance=${min_importance}`,
            { headers: authHeaders(), signal: timeout() },
          )
        } catch (err) {
          return fetchError(err)
        }
        if (!res.ok) return httpError(res)

        const data = (await res.json()) as {
          documentId: string
          claims: Array<{
            id: string
            sectionTitle: string
            sectionLineage: string
            text: string
            importance: number
            position: number
          }>
        }

        const claims = data.claims.slice(0, limit)
        if (claims.length === 0) {
          return { content: [{ type: 'text', text: 'No claims found.' }] }
        }

        const text = claims
          .map(
            (c, i) =>
              `[${i + 1}] [importance: ${c.importance}] ${c.text}\n  Section: ${c.sectionTitle}`,
          )
          .join('\n\n')
        return { content: [{ type: 'text', text }] }
      }

      // Collection-wide via SSE claims/map endpoint
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      let res: Response
      try {
        res = await fetch(`${API_URL}/collections/${collId}/claims/map`, {
          headers: { ...authHeaders(), Accept: 'text/event-stream' },
          signal: AbortSignal.timeout(60_000),
        })
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const result = await consumeClaimsStream(res)
      if (!result.ok) {
        return {
          content: [
            { type: 'text', text: `Claims fetch failed: ${result.message}` },
          ],
          isError: true,
        }
      }

      const filtered = result.claims
        .filter((c) => c.importance >= min_importance)
        .sort((a, b) => b.importance - a.importance)
        .slice(0, limit)

      if (filtered.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No claims found matching the criteria.' },
          ],
        }
      }

      const showing =
        filtered.length < result.total
          ? `Showing ${filtered.length} of ${result.total} total claims (importance ≥ ${min_importance}):\n\n`
          : `${filtered.length} claim(s):\n\n`

      const text =
        showing +
        filtered
          .map(
            (c, i) =>
              `[${i + 1}] [importance: ${c.importance}] ${c.text}\n  Document: ${c.documentName}\n  Section: ${c.sectionTitle}\n  Claim ID: ${c.id}`,
          )
          .join('\n\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_list_contradictions ───────────────────────────────────────────────

  server.tool(
    'dewey_list_contradictions',
    'List contradictions detected in a Dewey collection — clusters of claims that conflict with each other. Each contradiction includes an explanation, the conflicting claims with their source documents, and a suggested resolution instruction.',
    {
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
      severity: z
        .enum(['low', 'medium', 'high'])
        .optional()
        .describe('Filter by severity level.'),
      status: z
        .enum(['active', 'dismissed', 'applied'])
        .optional()
        .describe(
          'Filter by resolution status. Defaults to "active" (unresolved contradictions).',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Maximum number of contradictions to return (1–100). Defaults to 20.',
        ),
    },
    async ({ collection_id, severity, status = 'active', limit = 20 }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      const params = new URLSearchParams({ status, limit: String(limit) })
      if (severity) params.set('severity', severity)

      let res: Response
      try {
        res = await fetch(
          `${API_URL}/collections/${collId}/contradictions?${params}`,
          { headers: authHeaders(), signal: timeout() },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const data = (await res.json()) as {
        total: number
        items: Array<{
          id: string
          severity: string
          status: string
          explanation: string
          suggestedInstruction: string | null
          clusterTopicSummary: string | null
          createdAt: string
          claims: Array<{
            id: string
            text: string
            document: { id: string; filename: string }
            sectionTitle: string
          }>
        }>
      }

      if (data.items.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No ${status} contradictions found${severity ? ` with severity "${severity}"` : ''}.`,
            },
          ],
        }
      }

      const header =
        data.total > data.items.length
          ? `${data.total} total ${status} contradiction(s). Showing first ${data.items.length}:\n\n`
          : `${data.items.length} ${status} contradiction(s):\n\n`

      const text =
        header +
        data.items
          .map((c, i) => {
            const claimLines = c.claims
              .map(
                (claim) => `  • [${claim.document.filename}] "${claim.text}"`,
              )
              .join('\n')
            const resolution = c.suggestedInstruction
              ? `Suggested resolution: ${c.suggestedInstruction}`
              : 'No suggested resolution.'
            return [
              `[${i + 1}] ID: ${c.id} | Severity: ${c.severity}`,
              c.clusterTopicSummary ? `Topic: ${c.clusterTopicSummary}` : null,
              c.explanation,
              `\nConflicting claims:\n${claimLines}`,
              `\n${resolution}`,
            ]
              .filter(Boolean)
              .join('\n')
          })
          .join('\n\n---\n\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_detect_contradictions ─────────────────────────────────────────────

  server.tool(
    'dewey_detect_contradictions',
    'Trigger a contradiction detection run on a Dewey collection. Analyzes all extracted claims for conflicts, clusters contradicting statements, and generates resolution suggestions. The run is asynchronous — use dewey_list_contradictions after a few minutes to see results.',
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
        res = await fetch(
          `${API_URL}/collections/${collId}/contradictions/detect`,
          {
            method: 'POST',
            headers: jsonHeaders(),
            signal: timeout(),
          },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const run = (await res.json()) as {
        runId: string
        status: string
        enqueuedAt: string
      }

      return {
        content: [
          {
            type: 'text',
            text: `Contradiction detection started.\nRun ID: ${run.runId}\nStatus: ${run.status}\nEnqueued at: ${run.enqueuedAt}\n\nUse dewey_list_contradictions in a few minutes to view results.`,
          },
        ],
      }
    },
  )

  // ── dewey_resolve_contradiction ─────────────────────────────────────────────

  server.tool(
    'dewey_resolve_contradiction',
    'Apply or dismiss a detected contradiction in a Dewey collection. Applying appends a resolution instruction to the collection settings so future research respects the resolution. Dismissing marks the contradiction as ignored.',
    {
      contradiction_id: z
        .string()
        .describe(
          'Contradiction ID to resolve (from dewey_list_contradictions).',
        ),
      action: z
        .enum(['apply', 'dismiss'])
        .describe(
          '"apply" appends the resolution instruction to collection settings; "dismiss" marks the contradiction as ignored.',
        ),
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
      instruction: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Custom resolution instruction to append (apply only). Overrides the suggested instruction when provided.',
        ),
    },
    async ({ contradiction_id, action, collection_id, instruction }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      let res: Response
      try {
        if (action === 'apply') {
          res = await fetch(
            `${API_URL}/collections/${collId}/contradictions/${contradiction_id}/apply-instruction`,
            {
              method: 'POST',
              headers: jsonHeaders(),
              body: JSON.stringify(instruction ? { instruction } : {}),
              signal: timeout(),
            },
          )
        } else {
          res = await fetch(
            `${API_URL}/collections/${collId}/contradictions/${contradiction_id}`,
            {
              method: 'PATCH',
              headers: jsonHeaders(),
              body: JSON.stringify({ status: 'dismissed' }),
              signal: timeout(),
            },
          )
        }
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const verb = action === 'apply' ? 'applied' : 'dismissed'
      return {
        content: [
          {
            type: 'text',
            text: `Contradiction ${contradiction_id} ${verb} successfully.${action === 'apply' ? ' The resolution instruction has been appended to collection settings.' : ''}`,
          },
        ],
      }
    },
  )

  // ── dewey_get_collection_stats ──────────────────────────────────────────────

  server.tool(
    'dewey_get_collection_stats',
    'Get statistics for a Dewey collection: document count, storage usage, section and chunk counts, total extracted claims, and processing status breakdown.',
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
        res = await fetch(`${API_URL}/collections/${collId}/stats`, {
          headers: authHeaders(),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const stats = (await res.json()) as {
        docCount: number
        totalFileSizeBytes: number
        totalSections: number
        totalChunks: number
        statusCounts: Record<string, number>
        summarizedCount: number
        captionedCount: number
        claimsExtractedCount: number
        totalClaimsCount: number
      }

      const sizeMB = (stats.totalFileSizeBytes / 1024 / 1024).toFixed(1)
      const statusLines = Object.entries(stats.statusCounts)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')

      const text = [
        `Documents: ${stats.docCount} (${sizeMB} MB)`,
        `Sections:  ${stats.totalSections}`,
        `Chunks:    ${stats.totalChunks}`,
        `Claims:    ${stats.totalClaimsCount} (extracted from ${stats.claimsExtractedCount} docs)`,
        `Summarized:  ${stats.summarizedCount} docs`,
        `Captioned:   ${stats.captionedCount} docs`,
        `Status breakdown:\n${statusLines}`,
      ].join('\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_update_collection ─────────────────────────────────────────────────

  server.tool(
    'dewey_update_collection',
    'Update settings for a Dewey collection: name, description, custom instructions, visibility, and feature flags for summarization, captioning, and claim extraction. Instructions guide how research answers are framed.',
    {
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
      name: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('New name for the collection.'),
      description: z
        .string()
        .nullable()
        .optional()
        .describe('Short description of the collection. Pass null to clear.'),
      instructions: z
        .string()
        .max(4000)
        .nullable()
        .optional()
        .describe(
          'Custom instructions that guide research answers (e.g. "Always cite page numbers", "Treat the 2024 edition as authoritative"). Pass null to clear.',
        ),
      visibility: z
        .enum(['private', 'public'])
        .optional()
        .describe('Access visibility of the collection.'),
      enable_summarization: z
        .boolean()
        .optional()
        .describe(
          'Enable LLM-generated section summaries. Improves scan_sections quality.',
        ),
      enable_captioning: z
        .boolean()
        .optional()
        .describe('Enable AI captions for extracted images and tables.'),
      enable_claim_extraction: z
        .boolean()
        .optional()
        .describe(
          'Enable automatic extraction of factual claims from document content.',
        ),
      enable_deduplication: z
        .boolean()
        .optional()
        .describe(
          'Enable near-duplicate document detection. Non-canonical members are excluded from retrieval.',
        ),
      enable_reranking: z
        .boolean()
        .optional()
        .describe(
          'Re-score search results with a cross-encoder for higher relevance. Disable for lower query latency.',
        ),
    },
    async ({
      collection_id,
      name,
      description,
      instructions,
      visibility,
      enable_summarization,
      enable_captioning,
      enable_claim_extraction,
      enable_deduplication,
      enable_reranking,
    }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      const body: Record<string, unknown> = {}
      if (name !== undefined) body.name = name
      if (description !== undefined) body.description = description
      if (instructions !== undefined) body.instructions = instructions
      if (visibility !== undefined) body.visibility = visibility
      if (enable_summarization !== undefined)
        body.enableSummarization = enable_summarization
      if (enable_captioning !== undefined)
        body.enableCaptioning = enable_captioning
      if (enable_claim_extraction !== undefined)
        body.enableClaimExtraction = enable_claim_extraction
      if (enable_deduplication !== undefined)
        body.enableDeduplication = enable_deduplication
      if (enable_reranking !== undefined)
        body.enableReranking = enable_reranking

      let res: Response
      try {
        res = await fetch(`${API_URL}/collections/${collId}`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify(body),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const c = (await res.json()) as {
        id: string
        name: string
        visibility: string
        description?: string | null
        instructions?: string | null
        enableSummarization: boolean
        enableCaptioning: boolean
        enableClaimExtraction: boolean
        enableDeduplication: boolean
        enableReranking: boolean
      }

      const text = [
        `Collection updated: ${c.name} (${c.id})`,
        `Visibility: ${c.visibility}`,
        c.description ? `Description: ${c.description}` : null,
        c.instructions ? `Instructions: ${c.instructions}` : null,
        `Summarization:     ${c.enableSummarization ? 'enabled' : 'disabled'}`,
        `Captioning:        ${c.enableCaptioning ? 'enabled' : 'disabled'}`,
        `Claim extraction:  ${c.enableClaimExtraction ? 'enabled' : 'disabled'}`,
        `Deduplication:     ${c.enableDeduplication ? 'enabled' : 'disabled'}`,
        `Reranking:         ${c.enableReranking ? 'enabled' : 'disabled'}`,
      ]
        .filter(Boolean)
        .join('\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_delete_document ───────────────────────────────────────────────────

  server.tool(
    'dewey_delete_document',
    'Permanently delete a document from a Dewey collection by its ID. This removes the document along with all its sections, chunks, and extracted claims. This action cannot be undone.',
    {
      document_id: z
        .string()
        .describe('ID of the document to delete (from dewey_list_documents).'),
    },
    async ({ document_id }) => {
      let res: Response
      try {
        res = await fetch(`${API_URL}/documents/${document_id}`, {
          method: 'DELETE',
          headers: authHeaders(),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      return {
        content: [
          {
            type: 'text',
            text: `Document ${document_id} deleted successfully.`,
          },
        ],
      }
    },
  )

  // ── dewey_get_document_sections ────────────────────────────────────────────

  server.tool(
    'dewey_get_document_sections',
    'List all sections in a document — the table of contents with heading levels, positions, and section IDs. Use section IDs with dewey_get_section to load full content.',
    {
      document_id: z
        .string()
        .describe('Document ID (from dewey_list_documents).'),
    },
    async ({ document_id }) => {
      let res: Response
      try {
        res = await fetch(`${API_URL}/documents/${document_id}/sections`, {
          headers: authHeaders(),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const sections = (await res.json()) as Array<{
        id: string
        title: string
        level: number
        position: number
        markdownOffsetStart: number
        markdownOffsetEnd: number
      }>

      if (sections.length === 0) {
        return {
          content: [{ type: 'text', text: 'No sections found in document.' }],
        }
      }

      const text = sections
        .map((s) => {
          const indent = '  '.repeat(Math.max(0, s.level - 1))
          return `${indent}${'#'.repeat(s.level)} ${s.title} — ID: ${s.id}`
        })
        .join('\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_get_document_markdown ─────────────────────────────────────────────

  server.tool(
    'dewey_get_document_markdown',
    'Fetch the full Markdown content of a document as converted by Dewey. Use for document-level analysis when you need more context than individual sections provide.',
    {
      document_id: z
        .string()
        .describe('Document ID (from dewey_list_documents).'),
    },
    async ({ document_id }) => {
      let res: Response
      try {
        res = await fetch(`${API_URL}/documents/${document_id}/markdown`, {
          headers: authHeaders(),
          signal: AbortSignal.timeout(30_000), // Markdown can be large
        })
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const text = await res.text()
      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_retry_document ────────────────────────────────────────────────────

  server.tool(
    'dewey_retry_document',
    'Retry processing a document that failed ingestion. Clears the error state and re-queues the document through the processing pipeline.',
    {
      document_id: z
        .string()
        .describe('Document ID to retry (from dewey_list_documents).'),
    },
    async ({ document_id }) => {
      let res: Response
      try {
        res = await fetch(`${API_URL}/documents/${document_id}/retry`, {
          method: 'POST',
          headers: jsonHeaders(),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const doc = (await res.json()) as {
        id: string
        filename: string
        status: string
      }

      return {
        content: [
          {
            type: 'text',
            text: `Document "${doc.filename}" (${doc.id}) re-queued for processing. Status: ${doc.status}.`,
          },
        ],
      }
    },
  )

  // ── dewey_update_document ───────────────────────────────────────────────────

  server.tool(
    'dewey_update_document',
    'Update the tags and/or metadata on an existing document. Tags replace the existing tag set entirely. Metadata is shallow-merged with existing values by default; set replace_metadata to true to replace it entirely.',
    {
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID the document belongs to. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
      document_id: z
        .string()
        .describe('ID of the document to update (from dewey_list_documents).'),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          'New tag list. Replaces the existing tags entirely. Tags are lowercased and deduplicated automatically.',
        ),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe(
          'Metadata key-value pairs to set. Shallow-merged with existing metadata by default.',
        ),
      replace_metadata: z
        .boolean()
        .optional()
        .describe(
          'If true, replace all existing metadata instead of merging. Default false.',
        ),
    },
    async ({
      collection_id,
      document_id,
      tags,
      metadata,
      replace_metadata,
    }) => {
      const colId = collection_id ?? process.env.DEWEY_COLLECTION_ID
      if (!colId) return missingCollection()

      const body: Record<string, unknown> = {}
      if (tags !== undefined) body.tags = tags
      if (metadata !== undefined) body.metadata = metadata
      if (replace_metadata) body.replaceMetadata = true

      if (Object.keys(body).length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No fields to update — provide tags, metadata, or both.',
            },
          ],
        }
      }

      let res: Response
      try {
        res = await fetch(
          `${API_URL}/collections/${colId}/documents/${document_id}`,
          {
            method: 'PATCH',
            headers: jsonHeaders(),
            body: JSON.stringify(body),
            signal: timeout(),
          },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const doc = (await res.json()) as {
        id: string
        filename: string
        tags: string[]
        metadata: Record<string, unknown>
      }

      const parts: string[] = [
        `Document "${doc.filename}" (${doc.id}) updated.`,
      ]
      if (doc.tags.length > 0) parts.push(`Tags: ${doc.tags.join(', ')}`)
      if (Object.keys(doc.metadata).length > 0)
        parts.push(`Metadata: ${JSON.stringify(doc.metadata)}`)

      return { content: [{ type: 'text', text: parts.join('\n') }] }
    },
  )

  // ── dewey_get_contradiction_run ─────────────────────────────────────────────

  server.tool(
    'dewey_get_contradiction_run',
    'Get the status of the latest contradiction detection run for a collection. Use to poll progress after calling dewey_detect_contradictions.',
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
        res = await fetch(
          `${API_URL}/collections/${collId}/contradictions/runs/latest`,
          { headers: authHeaders(), signal: timeout() },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const run = (await res.json()) as {
        id: string
        status: string
        claimsProcessed: number | null
        clustersAnalyzed: number | null
        contradictionsFound: number | null
        model: string | null
        startedAt: string | null
        completedAt: string | null
        error: string | null
        createdAt: string
      }

      const lines = [
        `Run ID: ${run.id}`,
        `Status: ${run.status}`,
        run.model ? `Model: ${run.model}` : null,
        run.claimsProcessed != null
          ? `Claims processed: ${run.claimsProcessed}`
          : null,
        run.clustersAnalyzed != null
          ? `Clusters analyzed: ${run.clustersAnalyzed}`
          : null,
        run.contradictionsFound != null
          ? `Contradictions found: ${run.contradictionsFound}`
          : null,
        run.startedAt ? `Started: ${run.startedAt}` : null,
        run.completedAt ? `Completed: ${run.completedAt}` : null,
        run.error ? `Error: ${run.error}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      return { content: [{ type: 'text', text: lines }] }
    },
  )

  // ── dewey_recompute_summaries ───────────────────────────────────────────────

  server.tool(
    'dewey_recompute_summaries',
    'Re-run AI section summarization across all documents in a collection. Useful after changing the collection LLM model. Runs asynchronously — check dewey_get_collection_stats for progress.',
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
        res = await fetch(
          `${API_URL}/collections/${collId}/recompute/summaries`,
          { method: 'POST', headers: jsonHeaders(), signal: timeout() },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const { enqueued } = (await res.json()) as { enqueued: number }
      return {
        content: [
          {
            type: 'text',
            text: `Summarization queued for ${enqueued} document(s). Sections will be updated as each document is processed.`,
          },
        ],
      }
    },
  )

  // ── dewey_recompute_captions ────────────────────────────────────────────────

  server.tool(
    'dewey_recompute_captions',
    'Re-run AI captioning for all images and tables across all documents in a collection. Useful after changing the collection LLM model. Runs asynchronously.',
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
        res = await fetch(
          `${API_URL}/collections/${collId}/recompute/captions`,
          { method: 'POST', headers: jsonHeaders(), signal: timeout() },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const { enqueued } = (await res.json()) as { enqueued: number }
      return {
        content: [
          {
            type: 'text',
            text: `Captioning queued for ${enqueued} image/table chunk(s). Captions will be updated as each document is processed.`,
          },
        ],
      }
    },
  )

  // ── dewey_detect_duplicates ─────────────────────────────────────────────────

  server.tool(
    'dewey_detect_duplicates',
    'Trigger a deduplication run on a Dewey collection. Identifies near-duplicate documents by measuring shared content across chunks and marks one member of each cluster as canonical; non-canonical documents are excluded from retrieval and contradiction detection. Requires enable_deduplication on the collection. Runs asynchronously — use dewey_get_duplicate_run in a few minutes to view results.',
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
        res = await fetch(
          `${API_URL}/collections/${collId}/duplicates/detect`,
          { method: 'POST', headers: jsonHeaders(), signal: timeout() },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const run = (await res.json()) as {
        runId: string
        status: string
        jobsEnqueued: number
        enqueuedAt: string
      }

      return {
        content: [
          {
            type: 'text',
            text: `Deduplication started.\nRun ID: ${run.runId}\nStatus: ${run.status}\nDocuments queued: ${run.jobsEnqueued}\nEnqueued at: ${run.enqueuedAt}\n\nUse dewey_get_duplicate_run to poll progress, or dewey_list_duplicate_groups once it completes.`,
          },
        ],
      }
    },
  )

  // ── dewey_get_duplicate_run ─────────────────────────────────────────────────

  server.tool(
    'dewey_get_duplicate_run',
    'Get the status of the latest deduplication run for a collection. Use to poll progress after calling dewey_detect_duplicates.',
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
        res = await fetch(
          `${API_URL}/collections/${collId}/duplicates/runs/latest`,
          { headers: authHeaders(), signal: timeout() },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const run = (await res.json()) as {
        id: string
        status: string
        jobsEnqueued: number | null
        jobsProcessed: number | null
        duplicatesDetected: number | null
        duplicateGroupsCreated: number | null
        startedAt: string | null
        completedAt: string | null
        error: string | null
        createdAt: string
      }

      const lines = [
        `Run ID: ${run.id}`,
        `Status: ${run.status}`,
        run.jobsEnqueued != null && run.jobsProcessed != null
          ? `Progress: ${run.jobsProcessed}/${run.jobsEnqueued} documents`
          : null,
        run.duplicatesDetected != null
          ? `Duplicates detected: ${run.duplicatesDetected}`
          : null,
        run.duplicateGroupsCreated != null
          ? `Groups created: ${run.duplicateGroupsCreated}`
          : null,
        run.startedAt ? `Started: ${run.startedAt}` : null,
        run.completedAt ? `Completed: ${run.completedAt}` : null,
        run.error ? `Error: ${run.error}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      return { content: [{ type: 'text', text: lines }] }
    },
  )

  // ── dewey_list_duplicate_groups ─────────────────────────────────────────────

  server.tool(
    'dewey_list_duplicate_groups',
    'List near-duplicate groups in a Dewey collection. Each group contains one canonical document and one or more near-duplicate members, with coverage percentages describing how much of each pair overlaps.',
    {
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum groups to return (1–100). Defaults to 20.'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Pagination offset. Defaults to 0.'),
    },
    async ({ collection_id, limit = 20, offset = 0 }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      })

      let res: Response
      try {
        res = await fetch(
          `${API_URL}/collections/${collId}/duplicates?${params}`,
          { headers: authHeaders(), signal: timeout() },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const data = (await res.json()) as {
        total: number
        items: Array<{
          id: string
          canonicalDocumentId: string
          detectedAt: string
          members: Array<{
            id: string
            filename: string
            relationship: 'canonical' | 'near_duplicate' | null
            coverageToCanonical: number | null
            coverageFromCanonical: number | null
            createdAt: string
          }>
        }>
      }

      if (data.items.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No duplicate groups found. If deduplication has not been enabled, turn it on via the Dewey dashboard or PATCH /collections/:id with enableDeduplication: true, then run dewey_detect_duplicates.',
            },
          ],
        }
      }

      const header =
        data.total > data.items.length
          ? `${data.total} total duplicate group(s). Showing first ${data.items.length}:\n\n`
          : `${data.items.length} duplicate group(s):\n\n`

      const pct = (value: number | null) =>
        value == null ? '—' : `${Math.round(value * 100)}%`

      const text =
        header +
        data.items
          .map((g, i) => {
            const memberLines = g.members
              .map((m) => {
                if (m.relationship === 'canonical') {
                  return `  ★ [canonical] ${m.filename} (id: ${m.id})`
                }
                return `  • [near_duplicate] ${m.filename} (id: ${m.id}) — coverage to canonical: ${pct(m.coverageToCanonical)}, from canonical: ${pct(m.coverageFromCanonical)}`
              })
              .join('\n')
            return [
              `[${i + 1}] Group ${g.id}`,
              `Canonical document: ${g.canonicalDocumentId}`,
              `Detected: ${g.detectedAt}`,
              `Members:\n${memberLines}`,
            ].join('\n')
          })
          .join('\n\n---\n\n')

      return { content: [{ type: 'text', text }] }
    },
  )

  // ── dewey_promote_duplicate_canonical ───────────────────────────────────────

  server.tool(
    'dewey_promote_duplicate_canonical',
    'Promote a different member of a duplicate group to canonical. The previous canonical becomes a near_duplicate (excluded from retrieval). Coverage percentages are cleared since they describe the old pairing — re-run detection if you need fresh numbers.',
    {
      group_id: z
        .string()
        .describe('Duplicate group ID (from dewey_list_duplicate_groups).'),
      canonical_document_id: z
        .string()
        .describe(
          'Document ID to promote to canonical. Must be an existing member of the group.',
        ),
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
    },
    async ({ group_id, canonical_document_id, collection_id }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      let res: Response
      try {
        res = await fetch(
          `${API_URL}/collections/${collId}/duplicates/${group_id}`,
          {
            method: 'PATCH',
            headers: jsonHeaders(),
            body: JSON.stringify({
              canonicalDocumentId: canonical_document_id,
            }),
            signal: timeout(),
          },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      const data = (await res.json()) as {
        success: boolean
        changed: boolean
      }

      return {
        content: [
          {
            type: 'text',
            text: data.changed
              ? `Promoted ${canonical_document_id} to canonical in group ${group_id}. The previous canonical is now a near-duplicate and excluded from retrieval.`
              : `${canonical_document_id} is already canonical in group ${group_id}. No change.`,
          },
        ],
      }
    },
  )

  // ── dewey_disband_duplicate_group ───────────────────────────────────────────

  server.tool(
    'dewey_disband_duplicate_group',
    'Disband a duplicate group. All former members rejoin retrieval as distinct documents with no group membership or canonical relationship. Use this when Dewey groups documents that should be treated as independent.',
    {
      group_id: z.string().describe('Duplicate group ID to disband.'),
      collection_id: z
        .string()
        .optional()
        .describe(
          'Collection ID. Required if DEWEY_COLLECTION_ID env var is not set.',
        ),
    },
    async ({ group_id, collection_id }) => {
      const collId = collectionId(collection_id)
      if (!collId) return missingCollection()

      let res: Response
      try {
        res = await fetch(
          `${API_URL}/collections/${collId}/duplicates/${group_id}`,
          { method: 'DELETE', headers: authHeaders(), signal: timeout() },
        )
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      return {
        content: [
          {
            type: 'text',
            text: `Duplicate group ${group_id} disbanded. All former members are now independent documents in retrieval.`,
          },
        ],
      }
    },
  )

  // ── dewey_delete_collection ─────────────────────────────────────────────────

  server.tool(
    'dewey_delete_collection',
    'Permanently delete a Dewey collection and all its data: documents, sections, chunks, claims, and stored files. This action cannot be undone.',
    {
      collection_id: z
        .string()
        .describe(
          'ID of the collection to delete (from dewey_list_collections).',
        ),
    },
    async ({ collection_id }) => {
      let res: Response
      try {
        res = await fetch(`${API_URL}/collections/${collection_id}`, {
          method: 'DELETE',
          headers: authHeaders(),
          signal: timeout(),
        })
      } catch (err) {
        return fetchError(err)
      }
      if (!res.ok) return httpError(res)

      return {
        content: [
          {
            type: 'text',
            text: `Collection ${collection_id} and all its data deleted successfully.`,
          },
        ],
      }
    },
  )

  return server
}
