// ============================================================
// lib/knowledge-graph/__tests__/community-partition.test.ts — P6-5
//
// The pure Louvain partition primitive: clusters, stable lowest-id community ids,
// singletons, weight accumulation, and robustness to bad edges.
// ============================================================

import { describe, it, expect } from 'vitest'
import { louvainPartition } from '@/lib/knowledge-graph/community'

describe('louvainPartition (P6-5)', () => {
  it('separates disconnected clusters and ids each by its lowest member', () => {
    const nodes = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'z']
    const edges = [
      { source: 'a1', target: 'a2' }, { source: 'a2', target: 'a3' }, { source: 'a1', target: 'a3' },
      { source: 'b1', target: 'b2' }, { source: 'b2', target: 'b3' }, { source: 'b1', target: 'b3' },
    ]
    const parts = louvainPartition(nodes, edges)
    const ids = parts.map((p) => p.communityId).sort()
    expect(ids).toEqual(['a1', 'b1', 'z']) // two triangles + an isolated singleton
    const byId = new Map(parts.map((p) => [p.communityId, p.memberIds.sort()]))
    expect(byId.get('a1')).toEqual(['a1', 'a2', 'a3'])
    expect(byId.get('b1')).toEqual(['b1', 'b2', 'b3'])
    expect(byId.get('z')).toEqual(['z'])
  })

  it('every node lands in exactly one community', () => {
    const nodes = ['n1', 'n2', 'n3', 'n4']
    const parts = louvainPartition(nodes, [{ source: 'n1', target: 'n2' }])
    const members = parts.flatMap((p) => p.memberIds).sort()
    expect(members).toEqual(['n1', 'n2', 'n3', 'n4'])
  })

  it('ignores self-loops and edges to unknown nodes (never throws)', () => {
    const parts = louvainPartition(['n1', 'n2'], [
      { source: 'n1', target: 'n1' },       // self-loop
      { source: 'n1', target: 'ghost' },    // unknown endpoint
      { source: 'n1', target: 'n2', weight: 2 },
    ])
    expect(parts.flatMap((p) => p.memberIds).sort()).toEqual(['n1', 'n2'])
  })

  it('returns [] for no nodes', () => {
    expect(louvainPartition([], [])).toEqual([])
  })
})
