// ============================================================
// builder-tabular-tier-c.test.ts — P4-1 (D2) gate
//
// With TABULAR_TIER_C on, a document whose chunks are all deterministic tabular
// chunks (table_stats) must:
//   - run ZERO LLM extraction calls (extractEntitiesAndRelations not called)
//   - still produce schema entities (service + metric/dimension nodes) via the
//     real buildSchemaEntityGraph, persisted through upsertGraph.
//
// This is the playbook gate: "warehouse fixture: 0 LLM extraction calls, schema
// entities present." Isolated in its own file so the flag mock doesn't affect
// the shared builder.test.ts suite.
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Flag ON for this file only.
vi.mock('@/lib/config/feature-flags', () => ({
  TABULAR_TIER_C: true,
  KG_OWNER_GRAPH: false,
  KG_CRM_EDGES: false,
  PIPELINE_SHAPE_ROUTING: false,
  HIERARCHY_SCOPES: false,
}))

const { mockSupabase } = vi.hoisted(() => ({ mockSupabase: { from: vi.fn(), rpc: vi.fn() } }))
function mockChain(overrides: Record<string, any> = {}) {
  const chain: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    update: vi.fn().mockReturnThis(),
    then: (resolve: any) => resolve({ data: null, error: null }),
    ...overrides,
  }
  return chain
}
vi.mock('@/lib/supabase/server', () => ({ supabaseAdmin: mockSupabase }))

const { mockExtract } = vi.hoisted(() => ({ mockExtract: vi.fn() }))
vi.mock('@/lib/knowledge-graph/extractor', () => ({ extractEntitiesAndRelations: mockExtract }))

// Gate would return true (LLM) if consulted — proves the tabular path bypasses it.
const { mockShouldRun } = vi.hoisted(() => ({ mockShouldRun: vi.fn() }))
vi.mock('@/lib/knowledge-graph/extraction-gate', () => ({
  shouldRunExtractionChained: mockShouldRun,
}))

const { mockUpsertGraph, mockDeleteByDocument } = vi.hoisted(() => ({
  mockUpsertGraph: vi.fn(),
  mockDeleteByDocument: vi.fn(),
}))
vi.mock('@/lib/knowledge-graph/storage', () => ({
  upsertGraph: mockUpsertGraph,
  deleteByDocument: mockDeleteByDocument,
  upsertNodes: vi.fn(),
  upsertEdges: vi.fn(),
}))

vi.mock('@/lib/knowledge-graph/community', () => ({ detectCommunities: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/knowledge-graph/event-extractor', () => ({ extractAndUpsertEvents: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/indexing/chunk-text-store', () => ({
  readChunkText: (row: any) => row?.metadata?.chunk_text ?? '',
  hasFullChunkText: () => true,
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

// Real buildSchemaEntityGraph is used (bi-chunking NOT mocked).

import { buildGraphForDocuments } from '@/lib/knowledge-graph/builder'

const ORG = 'org-tier-c'
const DOC = 'doc-warehouse'

beforeEach(() => {
  vi.clearAllMocks()
  mockExtract.mockResolvedValue({ nodes: [], edges: [] })
  mockShouldRun.mockResolvedValue(true) // would run LLM if the tabular path didn't bypass
  mockUpsertGraph.mockResolvedValue(new Map())
  mockDeleteByDocument.mockResolvedValue(undefined)
  mockSupabase.rpc.mockResolvedValue({ data: 'fake-key', error: null })
})

describe('buildGraphForDocuments — tabular Tier C (P4-1 / D2)', () => {
  it('warehouse doc → 0 LLM extraction calls, schema entities persisted', async () => {
    const doc = {
      id: DOC,
      external_id: DOC,
      content_hash: 'h2',
      last_extracted_hash: null,
      department_id: null,
      visibility: 'org_wide',
      connection_id: 'conn-1',
      source_type: 'snowflake',
      title: 'analytics.orders',
      metadata: {},
    }
    const statsRow = {
      chunk_index: 0,
      content_preview: 'Table: analytics.orders',
      metadata: {
        provider: 'snowflake',
        resource_type: 'table_stats',
        table: 'analytics.orders',
        row_count: '1000',
        chunk_text: 'Table: analytics.orders (1000 rows)\nColumns:\n  amount number\n  region varchar',
        schema: [
          { name: 'amount', type: 'number' },
          { name: 'region', type: 'varchar' },
        ],
      },
    }

    mockSupabase.from
      .mockReturnValueOnce(mockChain({ single: vi.fn().mockResolvedValue({ data: doc, error: null }) })) // doc
      .mockReturnValueOnce(mockChain({ order: vi.fn().mockResolvedValue({ data: [statsRow], error: null }) })) // chunks
      .mockReturnValue(mockChain())

    await buildGraphForDocuments(ORG, [DOC], 'incremental')

    // Gate: zero LLM extraction.
    expect(mockExtract).not.toHaveBeenCalled()

    // Schema entities were produced and persisted.
    expect(mockUpsertGraph).toHaveBeenCalled()
    const [, nodes, edges] = mockUpsertGraph.mock.calls[0]
    const tableNode = nodes.find((n: any) => n.label === 'analytics.orders')
    expect(tableNode?.entity_type).toBe('service')
    expect(nodes.some((n: any) => n.label === 'analytics.orders.amount')).toBe(true)   // metric
    expect(nodes.some((n: any) => n.label === 'analytics.orders.region')).toBe(true)   // dimension
    expect(edges.some((e: any) => e.relation === 'FEEDS' && e.confidence === 1.0)).toBe(true)
    expect(edges.every((e: any) => e.provenance === 'EXTRACTED')).toBe(true)
  })
})
