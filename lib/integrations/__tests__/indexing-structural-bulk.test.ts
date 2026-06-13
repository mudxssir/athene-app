// P1-8/P1-9 bulk wiring — structural documents arriving through the bulk
// indexDocuments path (the connector sync entry point) must get parent/child
// rows, and late-chunking-eligible documents must be embedded per-document
// with late_chunking=true. Also covers the playbook parent/child integrity
// protocol: every child's parent row exists after the upsert+prune cycle.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Hoisted capture state ────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const state = {
    flagOn: false,
    upserts: [] as Array<{ table: string; rows: Record<string, unknown>[] }>,
    publishCalls: [] as Array<Record<string, unknown>>,
  }
  return state
})

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/config/feature-flags', () => ({
  get PIPELINE_SHAPE_ROUTING() { return h.flagOn },
  CONTEXT_ENVELOPE: false,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/supabase/server', () => {
  function makeBuilder(table: string) {
    const builder: Record<string, unknown> = {}
    const chain = () => builder
    Object.assign(builder, {
      select: vi.fn(chain),
      eq: vi.fn(chain),
      gte: vi.fn(chain),
      gt: vi.fn(chain),
      in: vi.fn(chain),
      order: vi.fn(chain),
      delete: vi.fn(chain),
      update: vi.fn(chain),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      single: vi.fn(async () => ({ data: { id: '00000000-0000-4000-8000-000000000001' }, error: null })),
      upsert: vi.fn((rows: Record<string, unknown> | Record<string, unknown>[]) => {
        h.upserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] })
        return builder
      }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null, count: 0 }),
    })
    return builder
  }
  return {
    supabaseAdmin: {
      from: vi.fn((table: string) => makeBuilder(table)),
      rpc: vi.fn(async () => ({ data: [], error: null })),
    },
  }
})

vi.mock('@/lib/qstash/client', () => ({
  qstash: {
    publishJSON: vi.fn(async (args: Record<string, unknown>) => {
      h.publishCalls.push(args)
      return { messageId: 'msg-1' }
    }),
  },
}))

const embedBatchPinned = vi.fn()
const embedBatchDetailed = vi.fn()
const embedBatchLateChunking = vi.fn()

vi.mock('@/lib/ai/embedding-factory', () => ({
  embedBatchPinned: (...args: unknown[]) => embedBatchPinned(...args),
  embedBatchDetailed: (...args: unknown[]) => embedBatchDetailed(...args),
  embedBatchLateChunking: (...args: unknown[]) => embedBatchLateChunking(...args),
}))

// Policy engine: per-shape plans so one dispatch can mix structural and token docs
const planByShape: Record<string, { strategy: string; parentTarget: number | null }> = {
  prose: { strategy: 'structural', parentTarget: 1200 },
  thread: { strategy: 'token', parentTarget: null },
  record: { strategy: 'token', parentTarget: null },
}

vi.mock('@/lib/indexing/chunk-policy', () => ({
  computeSignals: vi.fn(() => ({ tokens: 5000, headingDensity: 2, tableDensity: 0, codeFenceRatio: 0, sentenceLen: 80, listRatio: 0 })),
  selectStrategy: vi.fn((shape: string) => ({
    strategy: planByShape[shape]?.strategy ?? 'token',
    childTarget: 512,
    parentTarget: planByShape[shape]?.parentTarget ?? null,
    overlap: 0,
    noSplitCeiling: 600,
  })),
  truncateAtTokenCap: vi.fn((text: string) => ({ text, truncated: false })),
  neutralizeMonsterRuns: vi.fn((text: string) => text),
  countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  MIN_TOKENS: 64,
  MAX_CHUNKS_PER_DOC: 400,
  TRUNCATE_TOKEN_CAP: 200_000,
}))

vi.mock('@/lib/indexing/structural-chunker', () => ({
  splitByHeadings: vi.fn(() => [
    { text: 'section one text', headingTrail: ['H1'] },
    { text: 'section two text', headingTrail: ['H1', 'H2'] },
    { text: 'section three text', headingTrail: ['H1', 'H2b'] },
  ]),
  groupIntoParents: vi.fn(() => [
    { parentText: 'section one text', children: [{ text: 'section one text', headingTrail: ['H1'] }] },
    {
      parentText: 'section two text\n\nsection three text',
      children: [
        { text: 'section two text', headingTrail: ['H1', 'H2'] },
        { text: 'section three text', headingTrail: ['H1', 'H2b'] },
      ],
    },
  ]),
  splitFenceAtomic: vi.fn(() => [{ text: 'fence chunk', headingTrail: [] }]),
}))

vi.mock('@/lib/langgraph/tools/chunker', () => ({
  chunk: vi.fn((text: string) => [
    { text: `${text.slice(0, 10)}-a` },
    { text: `${text.slice(0, 10)}-b` },
  ]),
}))

import { indexDocuments } from '@/lib/integrations/indexing'
import type { FetchedChunk } from '@/lib/integrations/base'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-4000-8000-00000000aaaa'
const CONN_ID = '00000000-0000-4000-8000-00000000bbbb'
const DOC_ID = '00000000-0000-4000-8000-000000000001'

function makeChunk(shape: FetchedChunk['shape'], id = 'ext-1'): FetchedChunk {
  return {
    chunk_id: id,
    title: `Doc ${id}`,
    content: 'word '.repeat(500),
    source_url: 'https://example.com/doc',
    shape,
    metadata: { provider: 'notion' },
  } as FetchedChunk
}

function embeddingRows(): Record<string, unknown>[] {
  return h.upserts
    .filter(u => u.table === 'document_embeddings')
    .flatMap(u => u.rows)
}

beforeEach(() => {
  h.flagOn = true
  h.upserts.length = 0
  h.publishCalls.length = 0
  embedBatchPinned.mockReset()
  embedBatchDetailed.mockReset()
  embedBatchLateChunking.mockReset()
  embedBatchPinned.mockResolvedValue({
    embeddings: [[0.1], [0.2], [0.3]],
    model: 'jina-embeddings-v3',
    provider: 'jina',
  })
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
})

afterEach(() => {
  h.flagOn = false
})

// ── Bulk structural delegation ────────────────────────────────────────────────

describe('indexDocuments — structural docs delegate to the parent/child path', () => {
  it('a structural-strategy doc gets parent rows + children with parent_chunk_index', async () => {
    const result = await indexDocuments([makeChunk('prose')], ORG_ID, CONN_ID, null)

    const rows = embeddingRows()
    const parents = rows.filter(r => r.parent_chunk_index === null && r.embedding === null)
    const children = rows.filter(r => r.parent_chunk_index !== null)

    // 2 parent groups → 2 parents + 3 children (from the structural-chunker mock)
    expect(parents).toHaveLength(2)
    expect(children).toHaveLength(3)
    expect(result.indexed).toBe(1)
    expect(result.documentIds).toContain(DOC_ID)
  })

  it('mixed dispatch: structural doc → parent/child rows; token doc → standalone rows', async () => {
    await indexDocuments(
      [makeChunk('prose', 'ext-structural'), makeChunk('record', 'ext-token')],
      ORG_ID, CONN_ID, null
    )

    const rows = embeddingRows()
    const children = rows.filter(r => r.parent_chunk_index !== null)
    const standalone = rows.filter(r => r.parent_chunk_index === null && r.embedding !== null)

    expect(children.length).toBeGreaterThan(0)   // structural doc produced children
    expect(standalone.length).toBeGreaterThan(0) // token doc produced standalone rows
  })

  it('parent/child integrity: every child points at an existing parent row', async () => {
    await indexDocuments([makeChunk('prose')], ORG_ID, CONN_ID, null)

    const rows = embeddingRows()
    const parentIndexes = new Set(
      rows
        .filter(r => r.parent_chunk_index === null && r.embedding === null)
        .map(r => r.chunk_index)
    )
    const children = rows.filter(r => r.parent_chunk_index !== null)

    expect(children.length).toBeGreaterThan(0)
    for (const child of children) {
      expect(parentIndexes.has(child.parent_chunk_index)).toBe(true)
      // Parents are intentionally embedding-free and excluded from retry
      expect((child.chunk_index as number)).toBeGreaterThanOrEqual(parentIndexes.size)
    }
  })
})

// ── Bulk late chunking ────────────────────────────────────────────────────────

describe('indexDocuments — late-chunking-eligible docs embed per-document', () => {
  it('thread doc with >1 sub-chunks embeds with late_chunking=true', async () => {
    await indexDocuments([makeChunk('thread')], ORG_ID, CONN_ID, null)

    // Per-document call with lateChunking flag (4th arg) = true
    const lateCalls = embedBatchPinned.mock.calls.filter(c => c[3] === true)
    expect(lateCalls).toHaveLength(1)
    expect(lateCalls[0][0]).toHaveLength(2) // both sub-chunks in one call
  })

  it('late-chunked rows are not re-embedded by the hint-group batches', async () => {
    await indexDocuments([makeChunk('thread')], ORG_ID, CONN_ID, null)

    // Exactly one embedding call total — no duplicate hint-group call
    expect(embedBatchPinned).toHaveBeenCalledTimes(1)
    const rows = embeddingRows()
    for (const r of rows) {
      expect(r.embedding).not.toBeNull()
      expect(r.needs_embedding).toBe(false)
    }
  })

  it('record shape (not late-eligible) stays in hint-group batching', async () => {
    await indexDocuments([makeChunk('record')], ORG_ID, CONN_ID, null)

    const lateCalls = embedBatchPinned.mock.calls.filter(c => c[3] === true)
    expect(lateCalls).toHaveLength(0)
    expect(embedBatchPinned).toHaveBeenCalledTimes(1)
  })

  it('late-chunking failure → placeholder rows + embed-retry, batch docs unaffected', async () => {
    embedBatchPinned.mockReset()
    embedBatchPinned.mockImplementation(async (_texts: string[], _org: string, _hint: string, late?: boolean) => {
      if (late) throw new Error('jina late-chunking down')
      return { embeddings: [[0.1], [0.2]], model: 'jina-embeddings-v3', provider: 'jina' }
    })

    await indexDocuments(
      [makeChunk('thread', 'ext-late'), makeChunk('record', 'ext-batch')],
      ORG_ID, CONN_ID, null
    )

    const rows = embeddingRows()
    const placeholders = rows.filter(r => r.needs_embedding === true)
    const healthy = rows.filter(r => r.needs_embedding === false)

    expect(placeholders).toHaveLength(2)  // the thread doc's two sub-chunks
    expect(healthy).toHaveLength(2)       // the record doc's two sub-chunks
    expect(h.publishCalls).toHaveLength(1) // one retry job for the failed doc
  })
})
