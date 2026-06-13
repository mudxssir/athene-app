// Review fixes #2/#3/#5 — pinned-provider failure fallback in indexDocument /
// indexDocuments. Verifies that a pinned embedding failure NEVER loses a
// document: placeholder rows (embedding=null, needs_embedding=true) are
// upserted and an embed-retry job is enqueued, on every indexing path.

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

// Policy engine: tests flip the strategy via this mutable plan
const mockPlan = {
  strategy: 'token' as string,
  childTarget: 512,
  parentTarget: null as number | null,
  overlap: 0,
  noSplitCeiling: 600,
}

vi.mock('@/lib/indexing/chunk-policy', () => ({
  computeSignals: vi.fn(() => ({ tokens: 5000, headingDensity: 2, tableDensity: 0, codeFenceRatio: 0, sentenceLen: 80, listRatio: 0 })),
  selectStrategy: vi.fn(() => ({ ...mockPlan })),
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

import { indexDocument, indexDocuments } from '@/lib/integrations/indexing'
import type { FetchedChunk } from '@/lib/integrations/base'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-4000-8000-00000000aaaa'
const CONN_ID = '00000000-0000-4000-8000-00000000bbbb'
const DOC_ID = '00000000-0000-4000-8000-000000000001'

function makeChunk(shape: FetchedChunk['shape']): FetchedChunk {
  return {
    chunk_id: 'ext-1',
    title: 'Test Doc',
    content: 'word '.repeat(500),
    source_url: 'https://example.com/doc',
    shape,
    metadata: { provider: 'notion' },
  } as FetchedChunk
}

/** All document_embeddings rows captured across upsert calls. */
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
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
  mockPlan.strategy = 'token'
  mockPlan.parentTarget = null
})

afterEach(() => {
  h.flagOn = false
})

// ── Structural path (review fix #2 + #5) ─────────────────────────────────────

describe('indexDocument — structural path, pinned provider failure', () => {
  beforeEach(() => {
    mockPlan.strategy = 'structural'
    mockPlan.parentTarget = 1200
  })

  it('total failure → children become placeholders, parents stay clean, retry enqueued', async () => {
    embedBatchPinned.mockRejectedValue(new Error('jina down'))

    await indexDocument(makeChunk('prose'), ORG_ID, CONN_ID, null)

    const rows = embeddingRows()
    const parents = rows.filter(r => r.parent_chunk_index === null)
    const children = rows.filter(r => r.parent_chunk_index !== null)

    // 2 parent groups → 2 parents + 3 children
    expect(parents).toHaveLength(2)
    expect(children).toHaveLength(3)

    // Fix #5: parents explicitly carry needs_embedding=false (never retried)
    for (const p of parents) {
      expect(p.needs_embedding).toBe(false)
      expect(p.embedding).toBeNull()
    }
    // Fix #2: failed children are placeholders, not lost
    for (const c of children) {
      expect(c.needs_embedding).toBe(true)
      expect(c.embedding).toBeNull()
      expect(c.embedding_model).toBeNull()
    }

    // Retry job enqueued with idempotency key
    expect(h.publishCalls).toHaveLength(1)
    expect(h.publishCalls[0].url).toBe('https://app.test/api/worker/embed-retry')
    expect(h.publishCalls[0].deduplicationId).toBe(`org:embed-retry:${DOC_ID}`)
    expect(h.publishCalls[0].body).toEqual({ org_id: ORG_ID, document_id: DOC_ID })
  })

  it('partial failure → only the failed group\'s children are flagged', async () => {
    // Group 1 (1 child) fails; group 2 (2 children) succeeds
    embedBatchPinned
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ embeddings: [[0.1], [0.2]], model: 'jina-embeddings-v3', provider: 'jina' })

    await indexDocument(makeChunk('prose'), ORG_ID, CONN_ID, null)

    const children = embeddingRows().filter(r => r.parent_chunk_index !== null)
    const flagged = children.filter(c => c.needs_embedding === true)
    const healthy = children.filter(c => c.needs_embedding === false)

    expect(flagged).toHaveLength(1)
    expect(healthy).toHaveLength(2)
    for (const c of healthy) {
      expect(c.embedding).not.toBeNull()
      expect(c.embedding_model).toBe('jina-embeddings-v3')
    }
    expect(h.publishCalls).toHaveLength(1)
  })

  it('success → all rows needs_embedding=false, no retry job', async () => {
    embedBatchPinned.mockResolvedValue({ embeddings: [[0.1], [0.2]], model: 'jina-embeddings-v3', provider: 'jina' })

    await indexDocument(makeChunk('prose'), ORG_ID, CONN_ID, null)

    for (const r of embeddingRows()) {
      expect(r.needs_embedding).toBe(false)
    }
    expect(h.publishCalls).toHaveLength(0)
  })
})

// ── Standard path (P1-13, previously untested) ───────────────────────────────

describe('indexDocument — standard path, pinned provider failure', () => {
  it('failure → all rows are placeholders, retry enqueued', async () => {
    embedBatchPinned.mockRejectedValue(new Error('jina down'))

    await indexDocument(makeChunk('record'), ORG_ID, CONN_ID, null)

    const rows = embeddingRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.needs_embedding).toBe(true)
      expect(r.embedding).toBeNull()
      expect(r.embedding_model).toBeNull()
    }
    expect(h.publishCalls).toHaveLength(1)
    expect(h.publishCalls[0].deduplicationId).toBe(`org:embed-retry:${DOC_ID}`)
  })

  it('success → rows carry embeddings and needs_embedding=false', async () => {
    embedBatchPinned.mockResolvedValue({ embeddings: [[0.1], [0.2]], model: 'jina-embeddings-v3', provider: 'jina' })

    await indexDocument(makeChunk('record'), ORG_ID, CONN_ID, null)

    const rows = embeddingRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.needs_embedding).toBe(false)
      expect(r.embedding).not.toBeNull()
    }
    expect(h.publishCalls).toHaveLength(0)
  })
})

// ── Bulk path (review fix #3) ─────────────────────────────────────────────────

describe('indexDocuments — bulk path, batch failure', () => {
  it('flag ON: failed batch → placeholder rows kept + retry enqueued per doc', async () => {
    embedBatchPinned.mockRejectedValue(new Error('jina down'))

    const result = await indexDocuments([makeChunk('record')], ORG_ID, CONN_ID, null)

    const rows = embeddingRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.needs_embedding).toBe(true)
      expect(r.embedding).toBeNull()
    }
    expect(h.publishCalls).toHaveLength(1)
    expect(h.publishCalls[0].body).toEqual({ org_id: ORG_ID, document_id: DOC_ID })
    // Failure is still reported in counters (honest telemetry)
    expect(result.errors).toBeGreaterThan(0)
  })

  it('flag ON: success → rows embedded, needs_embedding=false, no retry', async () => {
    embedBatchPinned.mockResolvedValue({ embeddings: [[0.1], [0.2]], model: 'jina-embeddings-v3', provider: 'jina' })

    await indexDocuments([makeChunk('record')], ORG_ID, CONN_ID, null)

    const rows = embeddingRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.needs_embedding).toBe(false)
      expect(r.embedding).not.toBeNull()
    }
    expect(h.publishCalls).toHaveLength(0)
  })

  it('flag OFF: failed rows are filtered out (legacy behavior), no retry job', async () => {
    h.flagOn = false
    embedBatchDetailed.mockRejectedValue(new Error('provider down'))

    const result = await indexDocuments([makeChunk('record')], ORG_ID, CONN_ID, null)

    expect(embeddingRows()).toHaveLength(0)   // nothing upserted
    expect(h.publishCalls).toHaveLength(0)    // no retry queue in legacy mode
    expect(result.errors).toBeGreaterThan(0)
  })
})
