// ============================================================
// lib/integrations/__tests__/schema-entity-graph.test.ts — P4-1 (D2)
//
// buildSchemaEntityGraph: deterministic KG path for tabular docs. From a
// document's table_stats chunks (carrying `table` + `schema` in metadata) it
// produces a service node for the table, metric concept nodes (FEEDS) for
// numeric columns, and dimension concept nodes (PART_OF) for categorical
// columns — all EXTRACTED/1.0, zero LLM.
// ============================================================

import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/langgraph/llm-factory', () => ({ resolveModelClient: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { buildSchemaEntityGraph, TABULAR_RESOURCE_TYPES } from '@/lib/integrations/bi-chunking'

function statsChunk(table: string, schema: { name: string; type: string }[], rowCount = 100) {
  return {
    metadata: {
      provider: 'snowflake',
      resource_type: 'table_stats',
      table,
      row_count: String(rowCount),
      schema,
    },
  }
}

const ORG = 'org-1'
const DOC = 'doc-1'

describe('buildSchemaEntityGraph (P4-1 / D2)', () => {
  it('table → service node; numeric col → metric (FEEDS); categorical col → dimension (PART_OF)', () => {
    const { nodes, edges } = buildSchemaEntityGraph(
      [statsChunk('analytics.orders', [
        { name: 'amount', type: 'number' },
        { name: 'region', type: 'varchar' },
      ])],
      ORG, null, 'org_wide', DOC,
    )

    const table = nodes.find((n) => n.label === 'analytics.orders')!
    expect(table.entity_type).toBe('service')

    const metric = nodes.find((n) => n.label === 'analytics.orders.amount')!
    expect(metric.entity_type).toBe('concept')
    const dim = nodes.find((n) => n.label === 'analytics.orders.region')!
    expect(dim.entity_type).toBe('concept')

    // Every edge is deterministic provenance.
    for (const e of edges) {
      expect(e.provenance).toBe('EXTRACTED')
      expect(e.confidence).toBe(1.0)
    }
    const feeds = edges.find((e) => e.target_label === 'analytics.orders.amount')!
    expect(feeds.relation).toBe('FEEDS')
    const partOf = edges.find((e) => e.target_label === 'analytics.orders.region')!
    expect(partOf.relation).toBe('PART_OF')
  })

  it('handles multiple stats chunks (multi-table doc) in one pass', () => {
    const { nodes } = buildSchemaEntityGraph(
      [
        statsChunk('a.t1', [{ name: 'x', type: 'number' }]),
        statsChunk('b.t2', [{ name: 'y', type: 'varchar' }]),
      ],
      ORG, null, 'department', DOC,
    )
    expect(nodes.some((n) => n.label === 'a.t1' && n.entity_type === 'service')).toBe(true)
    expect(nodes.some((n) => n.label === 'b.t2' && n.entity_type === 'service')).toBe(true)
  })

  it('ignores non-stats chunks (sample/agg/prose) — only table_stats drives schema entities', () => {
    const { nodes } = buildSchemaEntityGraph(
      [
        { metadata: { provider: 'snowflake', resource_type: 'table_sample', table: 't', schema: [{ name: 'x', type: 'number' }] } },
        { metadata: { provider: 'notion', resource_type: 'page' } },
      ],
      ORG, null, 'org_wide', DOC,
    )
    expect(nodes).toHaveLength(0)
  })

  it('returns empty when schema metadata is missing or malformed', () => {
    expect(buildSchemaEntityGraph([statsChunk('t', [])], ORG, null, 'org_wide', DOC).nodes).toHaveLength(0)
    expect(
      buildSchemaEntityGraph(
        [{ metadata: { resource_type: 'table_stats', table: 't', schema: 'not-an-array' } }],
        ORG, null, 'org_wide', DOC,
      ).nodes,
    ).toHaveLength(0)
    expect(buildSchemaEntityGraph([{ metadata: null }], ORG, null, 'org_wide', DOC).nodes).toHaveLength(0)
  })

  it('TABULAR_RESOURCE_TYPES covers the deterministic tabular chunk kinds', () => {
    expect(TABULAR_RESOURCE_TYPES.has('table_stats')).toBe(true)
    expect(TABULAR_RESOURCE_TYPES.has('table_sample')).toBe(true)
    expect(TABULAR_RESOURCE_TYPES.has('table_aggregations')).toBe(true)
    expect(TABULAR_RESOURCE_TYPES.has('page')).toBe(false)
  })
})
