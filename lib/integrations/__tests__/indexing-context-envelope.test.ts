// ============================================================
// lib/integrations/__tests__/indexing-context-envelope.test.ts — P3-13
//
// With CONTEXT_ENVELOPE on, the EMBEDDED text carries the context header
// (breadcrumb + doc-context + situating) while the stored chunk_text stays RAW,
// the header is mirrored into metadata.context_header, and the doc-context line
// is persisted to documents.context_summary.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { FetchedChunk } from '@/lib/integrations/base'

const { embedBatchMock, supabaseState, docContextMock, situatingMock } = vi.hoisted(() => ({
  embedBatchMock: vi.fn(),
  docContextMock: vi.fn(),
  situatingMock: vi.fn(),
  supabaseState: {
    upsertCalls: [] as { table: string; records: unknown }[],
  },
}))

// Envelope ON; shape routing OFF (legacy chunking → uses embedBatchDetailed).
vi.mock('@/lib/config/feature-flags', () => ({
  CONTEXT_ENVELOPE: true,
  PIPELINE_SHAPE_ROUTING: false,
}))

vi.mock('@/lib/indexing/doc-context', () => ({ generateDocContext: docContextMock }))
vi.mock('@/lib/indexing/situating', () => ({
  generateSituatingLines: situatingMock,
  shapeGetsSituating: () => true,
}))

vi.mock('@/lib/ai/embedding-factory', () => ({
  embedBatch: embedBatchMock,
  embedBatchDetailed: async (texts: string[], orgId?: string, hint?: string) => ({
    embeddings: await embedBatchMock(texts, orgId, hint),
    model: 'test-model',
    provider: 'test',
  }),
  embedBatchLateChunking: async (texts: string[], orgId?: string, hint?: string) => ({
    embeddings: await embedBatchMock(texts, orgId, hint),
    model: 'test-model',
    provider: 'test',
  }),
  embedBatchPinned: vi.fn(),
  EMBEDDING_DIMS: 768,
}))

vi.mock('@/lib/supabase/server', () => {
  const leaf = (data: unknown) => ({
    maybeSingle: () => Promise.resolve({ data, error: null }),
    single: () => Promise.resolve({ data, error: null }),
  })
  function eqChain(data: unknown): any {
    return { eq: () => eqChain(data), ...leaf(data) }
  }
  const selectFn = (table: string) => () => eqChain(table === 'documents' ? null : null)
  const upsertFn = (table: string) => (records: unknown) => {
    supabaseState.upsertCalls.push({ table, records })
    if (table === 'document_embeddings') return Promise.resolve({ data: null, error: null, count: null })
    return { select: () => ({ single: () => Promise.resolve({ data: { id: 'doc-1' }, error: null }) }) }
  }
  const deleteFn = () => () => ({
    eq: () => ({ gte: () => Promise.resolve({ data: null, error: null }), gt: () => Promise.resolve({ data: null, error: null }) }),
  })
  const updateFn = (table: string) => (payload: unknown) => {
    supabaseState.upsertCalls.push({ table: `${table}:update`, records: payload })
    const p: any = { eq: () => p, then: (r: any) => r({ data: null, error: null }) }
    return p
  }
  return {
    supabaseAdmin: {
      from: (table: string) => ({
        select: selectFn(table),
        upsert: upsertFn(table),
        delete: deleteFn(),
        update: updateFn(table),
      }),
    },
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/qstash/client', () => ({ qstash: { publishJSON: vi.fn() } }))

import { indexDocuments } from '@/lib/integrations/indexing'

const ORG = 'org-aaaa'
const CONN = 'conn-bbbb'

function emailChunk(): FetchedChunk {
  return {
    chunk_id: 'gmail:m1',
    title: 'Invoice question',
    content: 'From: bob@x.com\n\nCan you resend the invoice for March?',
    source_url: 'https://mail/m1',
    shape: 'email',
    metadata: { provider: 'google', resource_type: 'email' },
  } as FetchedChunk
}

beforeEach(() => {
  vi.clearAllMocks()
  supabaseState.upsertCalls = []
  embedBatchMock.mockImplementation(async (texts: string[]) => texts.map(() => Array(768).fill(0.1)))
  docContextMock.mockResolvedValue('A short email asking to resend the March invoice.')
  situatingMock.mockImplementation(async (_ctx: string, chunks: string[]) => chunks.map(() => null))
})

describe('P3-13 — context envelope assembly (bulk path)', () => {
  it('embeds header+chunk, stores raw chunk_text, mirrors header to metadata', async () => {
    await indexDocuments([emailChunk()], ORG, CONN, null, 'org_wide')

    // The embedded text carries the breadcrumb + doc-context header.
    expect(embedBatchMock).toHaveBeenCalled()
    const embeddedText = embedBatchMock.mock.calls[0][0][0] as string
    expect(embeddedText).toContain('Gmail › Invoice question')          // breadcrumb (P3-11)
    expect(embeddedText).toContain('A short email asking to resend')     // doc-context (P3-10)
    expect(embeddedText).toContain('Can you resend the invoice')         // the chunk body

    // The STORED chunk_text is raw — no header leaked into citations/KG.
    const embRows = supabaseState.upsertCalls
      .filter((c) => c.table === 'document_embeddings')
      .flatMap((c) => (Array.isArray(c.records) ? c.records : [c.records])) as Array<{ metadata: Record<string, unknown>; content_hash: string }>
    expect(embRows.length).toBeGreaterThan(0)
    const row = embRows[0]
    expect(row.metadata.chunk_text).toBe('From: bob@x.com\n\nCan you resend the invoice for March?')
    expect(row.metadata.chunk_text).not.toContain('Gmail ›')
    // content_hash is of the RAW text (header never affects dedup).
    expect(row.content_hash).toBe(createHash('sha256').update(row.metadata.chunk_text as string).digest('hex'))
    // header mirrored to a separate metadata key.
    expect(row.metadata.context_header).toContain('Gmail › Invoice question')

    // doc-context persisted to documents.context_summary.
    const ctxUpdate = supabaseState.upsertCalls.find(
      (c) => c.table === 'documents:update' && (c.records as Record<string, unknown>).context_summary,
    )
    expect(ctxUpdate).toBeTruthy()
    expect((ctxUpdate!.records as Record<string, unknown>).context_summary).toContain('March invoice')
  })
})
