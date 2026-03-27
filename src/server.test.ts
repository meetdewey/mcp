import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from './server.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function setup() {
  const server = createServer()
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()

  const client = new Client({ name: 'test', version: '0.0.1' })
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])

  return { client, server }
}

function mockFetchOk(body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
}

function mockFetchError(status: number, body = 'Internal Server Error') {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(body, { status }))
}

// ── dewey_list_collections ────────────────────────────────────────────────────

describe('dewey_list_collections', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists collections', async () => {
    mockFetchOk([
      {
        id: 'col-1',
        name: 'Docs',
        visibility: 'private',
        embeddingModel: 'text-embedding-3-small',
      },
      {
        id: 'col-2',
        name: 'Public KB',
        visibility: 'public',
        embeddingModel: 'text-embedding-3-small',
      },
    ])

    const result = await client.callTool({
      name: 'dewey_list_collections',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Docs [private] — ID: col-1')
    expect(text).toContain('Public KB [public] — ID: col-2')
  })

  it('returns empty message when no collections', async () => {
    mockFetchOk([])

    const result = await client.callTool({
      name: 'dewey_list_collections',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toBe('No collections found.')
  })

  it('returns error on API failure', async () => {
    mockFetchError(401, 'Unauthorized')

    const result = await client.callTool({
      name: 'dewey_list_collections',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 401')
  })
})

// ── dewey_search ──────────────────────────────────────────────────────────────

describe('dewey_search', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  it('returns formatted search results', async () => {
    mockFetchOk([
      {
        score: 0.95,
        chunk: {
          id: 'c1',
          content: 'Some chunk text',
          position: 0,
          tokenCount: 10,
        },
        section: { id: 's1', title: 'Introduction', level: 1 },
        document: { id: 'd1', filename: 'guide.pdf' },
      },
    ])

    const result = await client.callTool({
      name: 'dewey_search',
      arguments: { query: 'test query' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Score: 0.950')
    expect(text).toContain('Document: guide.pdf')
    expect(text).toContain('Section: Introduction')
    expect(text).toContain('Some chunk text')
  })

  it('returns no results message', async () => {
    mockFetchOk([])

    const result = await client.callTool({
      name: 'dewey_search',
      arguments: { query: 'nothing here' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toBe('No results found.')
  })

  it('requires collection_id when env var is unset', async () => {
    delete process.env.DEWEY_COLLECTION_ID
    vi.spyOn(globalThis, 'fetch')

    const result = await client.callTool({
      name: 'dewey_search',
      arguments: { query: 'test' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('collection_id is required')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('passes collection_id and limit to the API', async () => {
    const spy = mockFetchOk([])

    await client.callTool({
      name: 'dewey_search',
      arguments: { query: 'test', collection_id: 'col-xyz', limit: 5 },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-xyz/query')
    expect(JSON.parse(init?.body as string)).toMatchObject({
      q: 'test',
      limit: 5,
    })
  })
})

// ── dewey_scan_sections ───────────────────────────────────────────────────────

describe('dewey_scan_sections', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  it('returns formatted section results', async () => {
    mockFetchOk({
      results: [
        {
          score: 0.88,
          section: {
            id: 'sec-1',
            title: 'Overview',
            level: 2,
            summary: 'A brief summary',
          },
          document: { id: 'd1', filename: 'manual.pdf' },
        },
      ],
    })

    const result = await client.callTool({
      name: 'dewey_scan_sections',
      arguments: { query: 'overview' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Score: 0.880')
    expect(text).toContain('Document: manual.pdf')
    expect(text).toContain('Section: Overview (h2)')
    expect(text).toContain('Summary: A brief summary')
    expect(text).toContain('Section ID: sec-1')
  })

  it('omits summary line when null', async () => {
    mockFetchOk({
      results: [
        {
          score: 0.7,
          section: { id: 'sec-2', title: 'Details', level: 3, summary: null },
          document: { id: 'd2', filename: 'spec.pdf' },
        },
      ],
    })

    const result = await client.callTool({
      name: 'dewey_scan_sections',
      arguments: { query: 'details' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).not.toContain('Summary:')
    expect(text).toContain('Section ID: sec-2')
  })

  it('returns no sections message when empty', async () => {
    mockFetchOk({ results: [] })

    const result = await client.callTool({
      name: 'dewey_scan_sections',
      arguments: { query: 'nothing' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toBe('No sections found.')
  })
})

// ── dewey_research ────────────────────────────────────────────────────────────

describe('dewey_research', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  function makeSseStream(events: object[]) {
    const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n`).join('\n')}\n`
    return new Response(new TextEncoder().encode(body), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  it('assembles streamed answer with sources', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSseStream([
        { type: 'scan', sectionCount: 5 },
        { type: 'chunk', content: 'Hello ' },
        { type: 'chunk', content: 'world.' },
        {
          type: 'done',
          sessionId: 'sess-1',
          sources: [
            { chunkId: 'c1', filename: 'doc.pdf', sectionTitle: 'Intro' },
          ],
        },
      ]),
    )

    const result = await client.callTool({
      name: 'dewey_research',
      arguments: { query: 'what is this?' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Hello world.')
    expect(text).toContain('**Sources:**')
    expect(text).toContain('[1] doc.pdf — Intro')
  })

  it('returns error event from stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSseStream([{ type: 'error', message: 'rate limit exceeded' }]),
    )

    const result = await client.callTool({
      name: 'dewey_research',
      arguments: { query: 'test' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('rate limit exceeded')
  })

  it('returns error on non-200 HTTP response', async () => {
    mockFetchError(403, 'Forbidden')

    const result = await client.callTool({
      name: 'dewey_research',
      arguments: { query: 'test' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 403')
  })
})

// ── dewey_list_documents ──────────────────────────────────────────────────────

describe('dewey_list_documents', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  it('lists documents with status and size', async () => {
    mockFetchOk([
      {
        id: 'doc-1',
        filename: 'report.pdf',
        status: 'ready',
        fileSizeBytes: 204800,
      },
      {
        id: 'doc-2',
        filename: 'error.pdf',
        status: 'error',
        fileSizeBytes: 1024,
        errorMessage: 'parse failed',
      },
    ])

    const result = await client.callTool({
      name: 'dewey_list_documents',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('report.pdf [ready] 200 KB — ID: doc-1')
    expect(text).toContain('error.pdf [error (parse failed)] 1 KB — ID: doc-2')
  })

  it('returns empty message when no documents', async () => {
    mockFetchOk([])

    const result = await client.callTool({
      name: 'dewey_list_documents',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toBe('No documents in this collection.')
  })

  it('requires collection_id when env var is unset', async () => {
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_list_documents',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('collection_id is required')
  })
})

// ── dewey_get_section ─────────────────────────────────────────────────────────

describe('dewey_get_section', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns section header and content', async () => {
    mockFetchOk({
      id: 'sec-1',
      title: 'Getting Started',
      level: 2,
      position: 3,
      documentId: 'doc-1',
      summary: 'Quick intro',
      content: '## Getting Started\n\nStep one...',
    })

    const result = await client.callTool({
      name: 'dewey_get_section',
      arguments: { section_id: 'sec-1' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('# Getting Started')
    expect(text).toContain('Level: h2 | Position: 3 | Document ID: doc-1')
    expect(text).toContain('Summary: Quick intro')
    expect(text).toContain('Step one...')
  })

  it('handles missing content gracefully', async () => {
    mockFetchOk({
      id: 'sec-2',
      title: 'Empty',
      level: 1,
      position: 0,
      documentId: 'doc-2',
      summary: null,
      content: null,
    })

    const result = await client.callTool({
      name: 'dewey_get_section',
      arguments: { section_id: 'sec-2' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('(content not available)')
    expect(text).not.toContain('Summary:')
  })

  it('passes section_id in request URL', async () => {
    const spy = mockFetchOk({
      id: 'sec-abc',
      title: 'T',
      level: 1,
      position: 0,
      documentId: 'd',
      summary: null,
      content: 'x',
    })

    await client.callTool({
      name: 'dewey_get_section',
      arguments: { section_id: 'sec-abc' },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('/sections/sec-abc')
  })
})
