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

  it('shows description when set', async () => {
    mockFetchOk([
      {
        id: 'col-1',
        name: 'Docs',
        visibility: 'private',
        embeddingModel: 'text-embedding-3-small',
        description: 'Internal engineering docs.',
      },
    ])

    const result = await client.callTool({
      name: 'dewey_list_collections',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Description: Internal engineering docs.')
  })

  it('shows instructions when set', async () => {
    mockFetchOk([
      {
        id: 'col-1',
        name: 'Docs',
        visibility: 'private',
        embeddingModel: 'text-embedding-3-small',
        instructions: 'All figures are in USD.',
      },
    ])

    const result = await client.callTool({
      name: 'dewey_list_collections',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Instructions: All figures are in USD.')
  })

  it('omits description and instructions lines when null', async () => {
    mockFetchOk([
      {
        id: 'col-1',
        name: 'Docs',
        visibility: 'private',
        embeddingModel: 'text-embedding-3-small',
        description: null,
        instructions: null,
      },
    ])

    const result = await client.callTool({
      name: 'dewey_list_collections',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).not.toContain('Description:')
    expect(text).not.toContain('Instructions:')
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
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
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
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
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
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
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
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
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
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
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
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
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

// ── dewey_list_claims ─────────────────────────────────────────────────────────

describe('dewey_list_claims', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  function makeClaimsSseStream(events: object[]) {
    const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n`).join('\n')}\n`
    return new Response(new TextEncoder().encode(body), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  // ── document_id path (regular JSON) ────────────────────────────────────────

  it('returns claims for a specific document', async () => {
    mockFetchOk({
      documentId: 'doc-1',
      claims: [
        {
          id: 'claim-1',
          sectionTitle: 'Results',
          sectionLineage: 'Results',
          text: 'The intervention reduced costs by 20%.',
          importance: 5,
          position: 0,
        },
        {
          id: 'claim-2',
          sectionTitle: 'Methods',
          sectionLineage: 'Methods',
          text: 'Participants were randomly assigned.',
          importance: 3,
          position: 1,
        },
      ],
    })

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { document_id: 'doc-1' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain(
      '[importance: 5] The intervention reduced costs by 20%.',
    )
    expect(text).toContain('Section: Results')
    expect(text).toContain(
      '[importance: 3] Participants were randomly assigned.',
    )
  })

  it('passes document_id and min_importance to API URL', async () => {
    const spy = mockFetchOk({ documentId: 'doc-1', claims: [] })

    await client.callTool({
      name: 'dewey_list_claims',
      arguments: { document_id: 'doc-1', min_importance: 4 },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('/documents/doc-1/claims')
    expect(url).toContain('minImportance=4')
  })

  it('respects limit for document path', async () => {
    mockFetchOk({
      documentId: 'doc-1',
      claims: Array.from({ length: 10 }, (_, i) => ({
        id: `claim-${i}`,
        sectionTitle: 'Sec',
        sectionLineage: 'Sec',
        text: `Claim ${i}`,
        importance: 5,
        position: i,
      })),
    })

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { document_id: 'doc-1', limit: 3 },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Claim 0')
    expect(text).toContain('Claim 2')
    expect(text).not.toContain('Claim 3')
  })

  it('returns no-claims message for empty document response', async () => {
    mockFetchOk({ documentId: 'doc-1', claims: [] })

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { document_id: 'doc-1' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toBe('No claims found.')
  })

  it('returns error on API failure for document path', async () => {
    mockFetchError(404, 'Not Found')

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { document_id: 'doc-missing' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 404')
  })

  // ── collection-wide path (SSE) ──────────────────────────────────────────────

  it('returns collection-wide claims via SSE stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeClaimsSseStream([
        { type: 'progress', pct: 50 },
        {
          type: 'done',
          total: 2,
          claims: [
            {
              id: 'c1',
              text: 'Revenue grew 15% YoY.',
              documentId: 'd1',
              documentName: 'annual.pdf',
              sectionId: 's1',
              sectionTitle: 'Financial Results',
              importance: 5,
              x: 0.1,
              y: 0.2,
            },
            {
              id: 'c2',
              text: 'Headcount increased by 50.',
              documentId: 'd1',
              documentName: 'annual.pdf',
              sectionId: 's2',
              sectionTitle: 'HR Summary',
              importance: 4,
              x: 0.3,
              y: 0.4,
            },
          ],
        },
      ]),
    )

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { min_importance: 3 },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Revenue grew 15% YoY.')
    expect(text).toContain('Headcount increased by 50.')
    expect(text).toContain('Document: annual.pdf')
    expect(text).toContain('Section: Financial Results')
    expect(text).toContain('Claim ID: c1')
  })

  it('filters collection-wide claims by min_importance', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeClaimsSseStream([
        {
          type: 'done',
          total: 3,
          claims: [
            {
              id: 'c1',
              text: 'High importance claim.',
              documentId: 'd1',
              documentName: 'doc.pdf',
              sectionId: 's1',
              sectionTitle: 'Sec',
              importance: 5,
              x: 0,
              y: 0,
            },
            {
              id: 'c2',
              text: 'Low importance claim.',
              documentId: 'd1',
              documentName: 'doc.pdf',
              sectionId: 's1',
              sectionTitle: 'Sec',
              importance: 2,
              x: 0,
              y: 0,
            },
            {
              id: 'c3',
              text: 'Medium importance claim.',
              documentId: 'd1',
              documentName: 'doc.pdf',
              sectionId: 's1',
              sectionTitle: 'Sec',
              importance: 1,
              x: 0,
              y: 0,
            },
          ],
        },
      ]),
    )

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { min_importance: 4 },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('High importance claim.')
    expect(text).not.toContain('Low importance claim.')
    expect(text).not.toContain('Medium importance claim.')
  })

  it('sorts collection-wide claims by importance descending', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeClaimsSseStream([
        {
          type: 'done',
          total: 2,
          claims: [
            {
              id: 'c-low',
              text: 'Low.',
              documentId: 'd1',
              documentName: 'doc.pdf',
              sectionId: 's1',
              sectionTitle: 'S',
              importance: 3,
              x: 0,
              y: 0,
            },
            {
              id: 'c-high',
              text: 'High.',
              documentId: 'd1',
              documentName: 'doc.pdf',
              sectionId: 's1',
              sectionTitle: 'S',
              importance: 5,
              x: 0,
              y: 0,
            },
          ],
        },
      ]),
    )

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { min_importance: 1 },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text.indexOf('High.')).toBeLessThan(text.indexOf('Low.'))
  })

  it('shows "Showing N of total" header when filtered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeClaimsSseStream([
        {
          type: 'done',
          total: 100,
          claims: [
            {
              id: 'c1',
              text: 'A claim.',
              documentId: 'd1',
              documentName: 'doc.pdf',
              sectionId: 's1',
              sectionTitle: 'S',
              importance: 5,
              x: 0,
              y: 0,
            },
          ],
        },
      ]),
    )

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { min_importance: 5 },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Showing 1 of 100 total claims')
    expect(text).toContain('importance ≥ 5')
  })

  it('returns no-claims message when all filtered out', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeClaimsSseStream([
        {
          type: 'done',
          total: 1,
          claims: [
            {
              id: 'c1',
              text: 'Low.',
              documentId: 'd1',
              documentName: 'doc.pdf',
              sectionId: 's1',
              sectionTitle: 'S',
              importance: 1,
              x: 0,
              y: 0,
            },
          ],
        },
      ]),
    )

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: { min_importance: 5 },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toBe('No claims found matching the criteria.')
  })

  it('returns error on SSE error event', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeClaimsSseStream([{ type: 'error', message: 'UMAP failed' }]),
    )

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('UMAP failed')
  })

  it('requires collection_id when env var unset and no document_id', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_list_claims',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('collection_id is required')
  })

  it('uses collection_id from env var for collection-wide path', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeClaimsSseStream([{ type: 'done', total: 0, claims: [] }]),
      )

    await client.callTool({
      name: 'dewey_list_claims',
      arguments: {},
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-default/claims/map')
  })
})

// ── dewey_list_contradictions ─────────────────────────────────────────────────

describe('dewey_list_contradictions', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  const sampleContradiction = {
    id: 'contra-1',
    severity: 'high',
    status: 'active',
    explanation: 'Document A says X while document B says Y.',
    suggestedInstruction: 'Prefer document B for post-2023 figures.',
    clusterTopicSummary: 'Revenue figures',
    createdAt: '2024-01-01T00:00:00Z',
    claims: [
      {
        id: 'claim-a',
        text: 'Revenue was $10M in 2023.',
        document: { id: 'd1', filename: 'report-a.pdf' },
        sectionTitle: 'Financials',
      },
      {
        id: 'claim-b',
        text: 'Revenue was $12M in 2023.',
        document: { id: 'd2', filename: 'report-b.pdf' },
        sectionTitle: 'Annual Summary',
      },
    ],
  }

  it('returns formatted contradictions with explanation and claims', async () => {
    mockFetchOk({ total: 1, items: [sampleContradiction] })

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('ID: contra-1 | Severity: high')
    expect(text).toContain('Document A says X while document B says Y.')
    expect(text).toContain('[report-a.pdf] "Revenue was $10M in 2023."')
    expect(text).toContain('[report-b.pdf] "Revenue was $12M in 2023."')
    expect(text).toContain('Prefer document B for post-2023 figures.')
  })

  it('shows cluster topic summary when present', async () => {
    mockFetchOk({ total: 1, items: [sampleContradiction] })

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Topic: Revenue figures')
  })

  it('omits topic line when clusterTopicSummary is null', async () => {
    mockFetchOk({
      total: 1,
      items: [{ ...sampleContradiction, clusterTopicSummary: null }],
    })

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).not.toContain('Topic:')
  })

  it('shows "No suggested resolution" when suggestedInstruction is null', async () => {
    mockFetchOk({
      total: 1,
      items: [{ ...sampleContradiction, suggestedInstruction: null }],
    })

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('No suggested resolution.')
  })

  it('passes severity filter as query param', async () => {
    const spy = mockFetchOk({ total: 0, items: [] })

    await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: { severity: 'high' },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('severity=high')
  })

  it('passes status filter as query param, defaulting to active', async () => {
    const spy = mockFetchOk({ total: 0, items: [] })

    await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('status=active')
  })

  it('passes explicit status to API', async () => {
    const spy = mockFetchOk({ total: 0, items: [] })

    await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: { status: 'dismissed' },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('status=dismissed')
  })

  it('passes limit to API', async () => {
    const spy = mockFetchOk({ total: 0, items: [] })

    await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: { limit: 5 },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('limit=5')
  })

  it('shows header with total when more items exist', async () => {
    mockFetchOk({ total: 42, items: [sampleContradiction] })

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('42 total active contradiction(s). Showing first 1')
  })

  it('returns no-contradictions message when empty', async () => {
    mockFetchOk({ total: 0, items: [] })

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('No active contradictions found')
  })

  it('includes severity in no-results message when filter provided', async () => {
    mockFetchOk({ total: 0, items: [] })

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: { severity: 'high' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('severity "high"')
  })

  it('returns error on API failure', async () => {
    mockFetchError(500, 'Internal Server Error')

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 500')
  })

  it('requires collection_id when env var is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_list_contradictions',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('collection_id is required')
  })
})

// ── dewey_detect_contradictions ───────────────────────────────────────────────

describe('dewey_detect_contradictions', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  it('returns run ID, status, and enqueued time', async () => {
    mockFetchOk({
      runId: 'run-abc',
      status: 'pending',
      enqueuedAt: '2024-06-01T12:00:00Z',
    })

    const result = await client.callTool({
      name: 'dewey_detect_contradictions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Run ID: run-abc')
    expect(text).toContain('Status: pending')
    expect(text).toContain('Enqueued at: 2024-06-01T12:00:00Z')
  })

  it('makes a POST request to the detect endpoint', async () => {
    const spy = mockFetchOk({
      runId: 'run-1',
      status: 'pending',
      enqueuedAt: '2024-01-01T00:00:00Z',
    })

    await client.callTool({
      name: 'dewey_detect_contradictions',
      arguments: {},
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-default/contradictions/detect')
    expect(init?.method).toBe('POST')
  })

  it('uses provided collection_id over env var', async () => {
    const spy = mockFetchOk({
      runId: 'run-1',
      status: 'pending',
      enqueuedAt: '2024-01-01T00:00:00Z',
    })

    await client.callTool({
      name: 'dewey_detect_contradictions',
      arguments: { collection_id: 'col-override' },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-override/contradictions/detect')
  })

  it('mentions dewey_list_contradictions in the output', async () => {
    mockFetchOk({
      runId: 'run-1',
      status: 'pending',
      enqueuedAt: '2024-01-01T00:00:00Z',
    })

    const result = await client.callTool({
      name: 'dewey_detect_contradictions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('dewey_list_contradictions')
  })

  it('returns error on API failure', async () => {
    mockFetchError(402, 'Payment Required')

    const result = await client.callTool({
      name: 'dewey_detect_contradictions',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 402')
  })

  it('requires collection_id when env var is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_detect_contradictions',
      arguments: {},
    })

    expect(result.isError).toBe(true)
  })
})

// ── dewey_resolve_contradiction ───────────────────────────────────────────────

describe('dewey_resolve_contradiction', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  it('calls apply-instruction endpoint when action is apply', async () => {
    const spy = mockFetchOk({ collection: { id: 'col-default' } })

    await client.callTool({
      name: 'dewey_resolve_contradiction',
      arguments: {
        contradiction_id: 'contra-1',
        action: 'apply',
      },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain(
      '/collections/col-default/contradictions/contra-1/apply-instruction',
    )
    expect(init?.method).toBe('POST')
  })

  it('passes custom instruction in body when provided', async () => {
    const spy = mockFetchOk({ collection: { id: 'col-default' } })

    await client.callTool({
      name: 'dewey_resolve_contradiction',
      arguments: {
        contradiction_id: 'contra-1',
        action: 'apply',
        instruction: 'Always prefer Q4 2023 figures.',
      },
    })

    const [, init] = spy.mock.calls[0] ?? []
    const body = JSON.parse(init?.body as string)
    expect(body.instruction).toBe('Always prefer Q4 2023 figures.')
  })

  it('sends empty body when no instruction provided for apply', async () => {
    const spy = mockFetchOk({ collection: { id: 'col-default' } })

    await client.callTool({
      name: 'dewey_resolve_contradiction',
      arguments: {
        contradiction_id: 'contra-1',
        action: 'apply',
      },
    })

    const [, init] = spy.mock.calls[0] ?? []
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({})
  })

  it('calls PATCH endpoint with dismissed status when action is dismiss', async () => {
    const spy = mockFetchOk({ success: true })

    await client.callTool({
      name: 'dewey_resolve_contradiction',
      arguments: {
        contradiction_id: 'contra-2',
        action: 'dismiss',
      },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-default/contradictions/contra-2')
    expect(init?.method).toBe('PATCH')
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({ status: 'dismissed' })
  })

  it('returns applied success message', async () => {
    mockFetchOk({ collection: { id: 'col-default' } })

    const result = await client.callTool({
      name: 'dewey_resolve_contradiction',
      arguments: { contradiction_id: 'contra-1', action: 'apply' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('contra-1')
    expect(text).toContain('applied')
    expect(text).toContain('resolution instruction')
  })

  it('returns dismissed success message', async () => {
    mockFetchOk({ success: true })

    const result = await client.callTool({
      name: 'dewey_resolve_contradiction',
      arguments: { contradiction_id: 'contra-2', action: 'dismiss' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('contra-2')
    expect(text).toContain('dismissed')
  })

  it('returns error on API failure', async () => {
    mockFetchError(404, 'Not Found')

    const result = await client.callTool({
      name: 'dewey_resolve_contradiction',
      arguments: { contradiction_id: 'missing', action: 'dismiss' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 404')
  })

  it('requires collection_id when env var is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_resolve_contradiction',
      arguments: { contradiction_id: 'contra-1', action: 'dismiss' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('collection_id is required')
  })
})

// ── dewey_get_collection_stats ────────────────────────────────────────────────

describe('dewey_get_collection_stats', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  const sampleStats = {
    docCount: 42,
    totalFileSizeBytes: 52428800, // 50 MB
    totalSections: 380,
    totalChunks: 1520,
    statusCounts: { ready: 40, error: 2 },
    summarizedCount: 35,
    captionedCount: 30,
    claimsExtractedCount: 40,
    totalClaimsCount: 8500,
  }

  it('returns formatted stats with document count and size', async () => {
    mockFetchOk(sampleStats)

    const result = await client.callTool({
      name: 'dewey_get_collection_stats',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Documents: 42')
    expect(text).toContain('50.0 MB')
  })

  it('returns section and chunk counts', async () => {
    mockFetchOk(sampleStats)

    const result = await client.callTool({
      name: 'dewey_get_collection_stats',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Sections:  380')
    expect(text).toContain('Chunks:    1520')
  })

  it('returns claims count and extraction count', async () => {
    mockFetchOk(sampleStats)

    const result = await client.callTool({
      name: 'dewey_get_collection_stats',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Claims:    8500')
    expect(text).toContain('extracted from 40 docs')
  })

  it('returns summarized and captioned counts', async () => {
    mockFetchOk(sampleStats)

    const result = await client.callTool({
      name: 'dewey_get_collection_stats',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Summarized:  35 docs')
    expect(text).toContain('Captioned:   30 docs')
  })

  it('returns status breakdown', async () => {
    mockFetchOk(sampleStats)

    const result = await client.callTool({
      name: 'dewey_get_collection_stats',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('ready: 40')
    expect(text).toContain('error: 2')
  })

  it('makes GET request to stats endpoint', async () => {
    const spy = mockFetchOk(sampleStats)

    await client.callTool({
      name: 'dewey_get_collection_stats',
      arguments: { collection_id: 'col-xyz' },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-xyz/stats')
  })

  it('returns error on API failure', async () => {
    mockFetchError(403, 'Forbidden')

    const result = await client.callTool({
      name: 'dewey_get_collection_stats',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 403')
  })

  it('requires collection_id when env var is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_get_collection_stats',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('collection_id is required')
  })
})

// ── dewey_update_collection ───────────────────────────────────────────────────

describe('dewey_update_collection', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  const updatedCollection = {
    id: 'col-default',
    name: 'Research Library',
    visibility: 'private',
    description: 'Internal research documents.',
    instructions: 'Always cite page numbers.',
    enableSummarization: true,
    enableCaptioning: false,
    enableClaimExtraction: true,
  }

  it('returns formatted collection after update', async () => {
    mockFetchOk(updatedCollection)

    const result = await client.callTool({
      name: 'dewey_update_collection',
      arguments: { name: 'Research Library' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Collection updated: Research Library')
    expect(text).toContain('Visibility: private')
  })

  it('shows feature flag enabled/disabled state', async () => {
    mockFetchOk(updatedCollection)

    const result = await client.callTool({
      name: 'dewey_update_collection',
      arguments: { enable_summarization: true },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Summarization:     enabled')
    expect(text).toContain('Captioning:        disabled')
    expect(text).toContain('Claim extraction:  enabled')
  })

  it('shows description and instructions when set', async () => {
    mockFetchOk(updatedCollection)

    const result = await client.callTool({
      name: 'dewey_update_collection',
      arguments: { instructions: 'Always cite page numbers.' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Description: Internal research documents.')
    expect(text).toContain('Instructions: Always cite page numbers.')
  })

  it('omits description and instructions lines when null', async () => {
    mockFetchOk({
      ...updatedCollection,
      description: null,
      instructions: null,
    })

    const result = await client.callTool({
      name: 'dewey_update_collection',
      arguments: { description: null },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).not.toContain('Description:')
    expect(text).not.toContain('Instructions:')
  })

  it('sends only provided fields in the PATCH body', async () => {
    const spy = mockFetchOk(updatedCollection)

    await client.callTool({
      name: 'dewey_update_collection',
      arguments: {
        instructions: 'Prefer primary sources.',
        visibility: 'public',
      },
    })

    const [, init] = spy.mock.calls[0] ?? []
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({
      instructions: 'Prefer primary sources.',
      visibility: 'public',
    })
    expect(body).not.toHaveProperty('name')
    expect(body).not.toHaveProperty('enableSummarization')
  })

  it('sends camelCase field names for feature flags', async () => {
    const spy = mockFetchOk(updatedCollection)

    await client.callTool({
      name: 'dewey_update_collection',
      arguments: {
        enable_summarization: true,
        enable_captioning: false,
        enable_claim_extraction: true,
      },
    })

    const [, init] = spy.mock.calls[0] ?? []
    const body = JSON.parse(init?.body as string)
    expect(body.enableSummarization).toBe(true)
    expect(body.enableCaptioning).toBe(false)
    expect(body.enableClaimExtraction).toBe(true)
  })

  it('makes PATCH request to collections endpoint', async () => {
    const spy = mockFetchOk(updatedCollection)

    await client.callTool({
      name: 'dewey_update_collection',
      arguments: { collection_id: 'col-xyz', name: 'New Name' },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-xyz')
    expect(init?.method).toBe('PATCH')
  })

  it('returns error on API failure', async () => {
    mockFetchError(400, 'Bad Request')

    const result = await client.callTool({
      name: 'dewey_update_collection',
      arguments: { name: 'Valid Name' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 400')
  })

  it('requires collection_id when env var is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_update_collection',
      arguments: { name: 'Test' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('collection_id is required')
  })
})

// ── dewey_delete_document ─────────────────────────────────────────────────────

describe('dewey_delete_document', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns success message after deletion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    )

    const result = await client.callTool({
      name: 'dewey_delete_document',
      arguments: { document_id: 'doc-abc' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('doc-abc')
    expect(text).toContain('deleted successfully')
  })

  it('makes DELETE request to correct URL', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))

    await client.callTool({
      name: 'dewey_delete_document',
      arguments: { document_id: 'doc-xyz' },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/documents/doc-xyz')
    expect(init?.method).toBe('DELETE')
  })

  it('returns error on 404', async () => {
    mockFetchError(404, 'Not Found')

    const result = await client.callTool({
      name: 'dewey_delete_document',
      arguments: { document_id: 'doc-missing' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 404')
  })

  it('returns error on API failure', async () => {
    mockFetchError(500, 'Internal Server Error')

    const result = await client.callTool({
      name: 'dewey_delete_document',
      arguments: { document_id: 'doc-1' },
    })

    expect(result.isError).toBe(true)
  })
})

// ── dewey_get_document_sections ───────────────────────────────────────────────

describe('dewey_get_document_sections', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns indented section tree', async () => {
    mockFetchOk([
      {
        id: 's1',
        title: 'Introduction',
        level: 1,
        position: 0,
        markdownOffsetStart: 0,
        markdownOffsetEnd: 500,
      },
      {
        id: 's2',
        title: 'Background',
        level: 2,
        position: 1,
        markdownOffsetStart: 500,
        markdownOffsetEnd: 1000,
      },
      {
        id: 's3',
        title: 'Methods',
        level: 1,
        position: 2,
        markdownOffsetStart: 1000,
        markdownOffsetEnd: 2000,
      },
    ])

    const result = await client.callTool({
      name: 'dewey_get_document_sections',
      arguments: { document_id: 'doc-1' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('# Introduction — ID: s1')
    expect(text).toContain('  ## Background — ID: s2')
    expect(text).toContain('# Methods — ID: s3')
  })

  it('indents nested headings by level - 1', async () => {
    mockFetchOk([
      {
        id: 's1',
        title: 'Top',
        level: 1,
        position: 0,
        markdownOffsetStart: 0,
        markdownOffsetEnd: 100,
      },
      {
        id: 's2',
        title: 'Mid',
        level: 3,
        position: 1,
        markdownOffsetStart: 100,
        markdownOffsetEnd: 200,
      },
    ])

    const result = await client.callTool({
      name: 'dewey_get_document_sections',
      arguments: { document_id: 'doc-1' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    // level 3 → 2 spaces of indent
    expect(text).toContain('    ### Mid — ID: s2')
  })

  it('returns no-sections message when empty', async () => {
    mockFetchOk([])

    const result = await client.callTool({
      name: 'dewey_get_document_sections',
      arguments: { document_id: 'doc-1' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toBe('No sections found in document.')
  })

  it('makes GET request to sections endpoint', async () => {
    const spy = mockFetchOk([])

    await client.callTool({
      name: 'dewey_get_document_sections',
      arguments: { document_id: 'doc-abc' },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('/documents/doc-abc/sections')
  })

  it('returns error on API failure', async () => {
    mockFetchError(404, 'Not Found')

    const result = await client.callTool({
      name: 'dewey_get_document_sections',
      arguments: { document_id: 'doc-missing' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 404')
  })
})

// ── dewey_get_document_markdown ───────────────────────────────────────────────

describe('dewey_get_document_markdown', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns plain Markdown content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('# Hello\n\nSome content here.', {
        status: 200,
        headers: { 'Content-Type': 'text/markdown' },
      }),
    )

    const result = await client.callTool({
      name: 'dewey_get_document_markdown',
      arguments: { document_id: 'doc-1' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('# Hello')
    expect(text).toContain('Some content here.')
  })

  it('makes GET request to markdown endpoint', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('# Doc', { status: 200 }))

    await client.callTool({
      name: 'dewey_get_document_markdown',
      arguments: { document_id: 'doc-xyz' },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('/documents/doc-xyz/markdown')
  })

  it('returns error on API failure', async () => {
    mockFetchError(404, 'Not Found')

    const result = await client.callTool({
      name: 'dewey_get_document_markdown',
      arguments: { document_id: 'doc-missing' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 404')
  })
})

// ── dewey_retry_document ──────────────────────────────────────────────────────

describe('dewey_retry_document', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns re-queued confirmation with filename and status', async () => {
    mockFetchOk({ id: 'doc-1', filename: 'report.pdf', status: 'uploading' })

    const result = await client.callTool({
      name: 'dewey_retry_document',
      arguments: { document_id: 'doc-1' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('report.pdf')
    expect(text).toContain('doc-1')
    expect(text).toContain('uploading')
  })

  it('makes POST request to retry endpoint', async () => {
    const spy = mockFetchOk({
      id: 'doc-abc',
      filename: 'file.pdf',
      status: 'uploading',
    })

    await client.callTool({
      name: 'dewey_retry_document',
      arguments: { document_id: 'doc-abc' },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/documents/doc-abc/retry')
    expect(init?.method).toBe('POST')
  })

  it('returns error on API failure', async () => {
    mockFetchError(404, 'Not Found')

    const result = await client.callTool({
      name: 'dewey_retry_document',
      arguments: { document_id: 'doc-missing' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 404')
  })
})

// ── dewey_get_contradiction_run ───────────────────────────────────────────────

describe('dewey_get_contradiction_run', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  const completedRun = {
    id: 'run-1',
    status: 'completed',
    claimsProcessed: 500,
    clustersAnalyzed: 42,
    contradictionsFound: 7,
    model: 'gpt-4o-mini',
    startedAt: '2024-06-01T12:00:00Z',
    completedAt: '2024-06-01T12:05:00Z',
    error: null,
    createdAt: '2024-06-01T12:00:00Z',
  }

  it('returns run status and stats', async () => {
    mockFetchOk(completedRun)

    const result = await client.callTool({
      name: 'dewey_get_contradiction_run',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Run ID: run-1')
    expect(text).toContain('Status: completed')
    expect(text).toContain('Claims processed: 500')
    expect(text).toContain('Clusters analyzed: 42')
    expect(text).toContain('Contradictions found: 7')
    expect(text).toContain('Model: gpt-4o-mini')
  })

  it('shows started and completed timestamps', async () => {
    mockFetchOk(completedRun)

    const result = await client.callTool({
      name: 'dewey_get_contradiction_run',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Started: 2024-06-01T12:00:00Z')
    expect(text).toContain('Completed: 2024-06-01T12:05:00Z')
  })

  it('omits null fields', async () => {
    mockFetchOk({
      ...completedRun,
      claimsProcessed: null,
      clustersAnalyzed: null,
      contradictionsFound: null,
      model: null,
      startedAt: null,
      completedAt: null,
    })

    const result = await client.callTool({
      name: 'dewey_get_contradiction_run',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).not.toContain('Claims processed')
    expect(text).not.toContain('Model:')
    expect(text).not.toContain('Started:')
  })

  it('shows error field when run failed', async () => {
    mockFetchOk({ ...completedRun, status: 'failed', error: 'Out of credits' })

    const result = await client.callTool({
      name: 'dewey_get_contradiction_run',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('Status: failed')
    expect(text).toContain('Error: Out of credits')
  })

  it('makes GET request to correct endpoint', async () => {
    const spy = mockFetchOk(completedRun)

    await client.callTool({
      name: 'dewey_get_contradiction_run',
      arguments: { collection_id: 'col-xyz' },
    })

    const [url] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-xyz/contradictions/runs/latest')
  })

  it('returns error on API failure', async () => {
    mockFetchError(404, 'Not Found')

    const result = await client.callTool({
      name: 'dewey_get_contradiction_run',
      arguments: {},
    })

    expect(result.isError).toBe(true)
  })

  it('requires collection_id when env var is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_get_contradiction_run',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('collection_id is required')
  })
})

// ── dewey_recompute_summaries ─────────────────────────────────────────────────

describe('dewey_recompute_summaries', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  it('returns enqueued count', async () => {
    mockFetchOk({ enqueued: 12 })

    const result = await client.callTool({
      name: 'dewey_recompute_summaries',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('12 document(s)')
  })

  it('makes POST request to summaries endpoint', async () => {
    const spy = mockFetchOk({ enqueued: 5 })

    await client.callTool({
      name: 'dewey_recompute_summaries',
      arguments: { collection_id: 'col-xyz' },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-xyz/recompute/summaries')
    expect(init?.method).toBe('POST')
  })

  it('returns error on API failure', async () => {
    mockFetchError(403, 'Forbidden')

    const result = await client.callTool({
      name: 'dewey_recompute_summaries',
      arguments: {},
    })

    expect(result.isError).toBe(true)
  })

  it('requires collection_id when env var is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_recompute_summaries',
      arguments: {},
    })

    expect(result.isError).toBe(true)
  })
})

// ── dewey_recompute_captions ──────────────────────────────────────────────────

describe('dewey_recompute_captions', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
    process.env.DEWEY_COLLECTION_ID = 'col-default'
  })

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID
    vi.restoreAllMocks()
  })

  it('returns enqueued count', async () => {
    mockFetchOk({ enqueued: 30 })

    const result = await client.callTool({
      name: 'dewey_recompute_captions',
      arguments: {},
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('30 image/table chunk(s)')
  })

  it('makes POST request to captions endpoint', async () => {
    const spy = mockFetchOk({ enqueued: 8 })

    await client.callTool({
      name: 'dewey_recompute_captions',
      arguments: { collection_id: 'col-xyz' },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-xyz/recompute/captions')
    expect(init?.method).toBe('POST')
  })

  it('returns error on API failure', async () => {
    mockFetchError(403, 'Forbidden')

    const result = await client.callTool({
      name: 'dewey_recompute_captions',
      arguments: {},
    })

    expect(result.isError).toBe(true)
  })

  it('requires collection_id when env var is unset', async () => {
    // biome-ignore lint/performance/noDelete: assigning undefined sets the string "undefined"; delete is required to truly unset
    delete process.env.DEWEY_COLLECTION_ID

    const result = await client.callTool({
      name: 'dewey_recompute_captions',
      arguments: {},
    })

    expect(result.isError).toBe(true)
  })
})

// ── dewey_delete_collection ───────────────────────────────────────────────────

describe('dewey_delete_collection', () => {
  let client: Client

  beforeEach(async () => {
    ;({ client } = await setup())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns success message after deletion', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    )

    const result = await client.callTool({
      name: 'dewey_delete_collection',
      arguments: { collection_id: 'col-abc' },
    })
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''

    expect(text).toContain('col-abc')
    expect(text).toContain('deleted successfully')
  })

  it('makes DELETE request to correct URL', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))

    await client.callTool({
      name: 'dewey_delete_collection',
      arguments: { collection_id: 'col-xyz' },
    })

    const [url, init] = spy.mock.calls[0] ?? []
    expect(url).toContain('/collections/col-xyz')
    expect(init?.method).toBe('DELETE')
  })

  it('returns error on API failure', async () => {
    mockFetchError(404, 'Not Found')

    const result = await client.callTool({
      name: 'dewey_delete_collection',
      arguments: { collection_id: 'col-missing' },
    })

    expect(result.isError).toBe(true)
    const text =
      (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ''
    expect(text).toContain('API error 404')
  })
})
