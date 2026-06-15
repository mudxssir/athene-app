// ============================================================
// lib/knowledge-graph/__tests__/community-scopes.test.ts — P6-5
//
// Per-app community-scope build: ensures a community kg_scope (parent = app) +
// memberships per cluster, skips sub-MIN apps/clusters, and prunes stale
// communities. louvainPartition + supabase mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { dbResponses, scopeUpserts, memberUpserts, pruneNotArgs, partitionMock } = vi.hoisted(() => ({
  dbResponses: [] as Array<{ data?: unknown; error?: unknown }>,
  scopeUpserts: [] as Array<Record<string, unknown>>,
  memberUpserts: [] as Array<Array<Record<string, unknown>>>,
  pruneNotArgs: [] as string[],
  partitionMock: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/knowledge-graph/community', () => ({ louvainPartition: partitionMock }))

vi.mock('@/lib/supabase/server', () => {
  const next = () => dbResponses.shift() ?? { data: [], error: null }
  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq', 'range']) b[m] = vi.fn(() => b)
    b.not = vi.fn((_c: string, _op: string, list: string) => { pruneNotArgs.push(list); return b })
    b.delete = vi.fn(() => b)
    b.upsert = vi.fn((payload: unknown) => {
      if (table === 'kg_scope_members') memberUpserts.push(payload as Array<Record<string, unknown>>)
      else scopeUpserts.push(payload as Record<string, unknown>)
      return b
    })
    b.single = vi.fn(() => Promise.resolve(next()))
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve, reject)
    return b
  }
  return { supabaseAdmin: { from: vi.fn((t: string) => makeBuilder(t)) } }
})

import { buildCommunityScopes, MIN_COMMUNITY_SIZE } from '@/lib/knowledge-graph/community-scopes'

const ORG = 'org-1'

beforeEach(() => {
  vi.clearAllMocks()
  dbResponses.length = 0
  scopeUpserts.length = 0
  memberUpserts.length = 0
  pruneNotArgs.length = 0
})

describe('buildCommunityScopes (P6-5)', () => {
  it('creates a community scope (parent = app) + memberships per cluster', async () => {
    dbResponses.push({ data: [{ id: 'app-jira', key: 'jira' }], error: null }) // app scopes
    dbResponses.push({ data: [], error: null })                                // org edges (page)
    dbResponses.push({ data: [{ node_id: 'n1' }, { node_id: 'n2' }, { node_id: 'n3' }], error: null }) // members
    partitionMock.mockReturnValue([{ communityId: 'n1', memberIds: ['n1', 'n2', 'n3'] }])
    dbResponses.push({ data: { id: 'comm-1' }, error: null })  // community scope upsert .single()
    dbResponses.push({ error: null })                          // member upsert
    dbResponses.push({ error: null })                          // prune

    const summary = await buildCommunityScopes(ORG)
    expect(summary).toEqual({ appsProcessed: 1, communitiesCreated: 1 })

    expect(scopeUpserts[0]).toMatchObject({
      level: 'community', key: 'jira#n1', parent_scope_id: 'app-jira',
    })
    expect(memberUpserts[0].map((r) => r.node_id)).toEqual(['n1', 'n2', 'n3'])
    expect(memberUpserts[0].every((r) => r.scope_id === 'comm-1' && r.org_id === ORG)).toBe(true)
    // Pruned everything except the kept community key.
    expect(pruneNotArgs[0]).toContain('jira#n1')
  })

  it('skips an app below MIN_COMMUNITY_SIZE members (prunes its communities)', async () => {
    dbResponses.push({ data: [{ id: 'app-x', key: 'slack' }], error: null }) // app scopes
    dbResponses.push({ data: [], error: null })                              // edges
    dbResponses.push({ data: [{ node_id: 'only1' }], error: null })          // 1 member < MIN

    const summary = await buildCommunityScopes(ORG)
    expect(summary).toEqual({ appsProcessed: 0, communitiesCreated: 0 })
    expect(scopeUpserts).toHaveLength(0)
    expect(partitionMock).not.toHaveBeenCalled()
  })

  it('filters out clusters smaller than MIN_COMMUNITY_SIZE', async () => {
    dbResponses.push({ data: [{ id: 'app-jira', key: 'jira' }], error: null })
    dbResponses.push({ data: [], error: null })
    dbResponses.push({ data: [{ node_id: 'a' }, { node_id: 'b' }, { node_id: 'c' }, { node_id: 'd' }], error: null })
    // One big cluster (kept) + one pair (dropped).
    partitionMock.mockReturnValue([
      { communityId: 'a', memberIds: ['a', 'b', 'c'] },
      { communityId: 'd', memberIds: ['d'] },
    ])
    dbResponses.push({ data: { id: 'comm-a' }, error: null }) // only the ≥MIN cluster upserts
    dbResponses.push({ error: null })                         // member upsert
    dbResponses.push({ error: null })                         // prune

    const summary = await buildCommunityScopes(ORG)
    expect(summary.communitiesCreated).toBe(1)
    expect(scopeUpserts).toHaveLength(1)
    expect(scopeUpserts[0]).toMatchObject({ key: 'jira#a' })
  })

  it('no-ops with no app scopes', async () => {
    dbResponses.push({ data: [], error: null })
    expect(await buildCommunityScopes(ORG)).toEqual({ appsProcessed: 0, communitiesCreated: 0 })
  })

  it('MIN_COMMUNITY_SIZE is conservative (≥3)', () => {
    expect(MIN_COMMUNITY_SIZE).toBeGreaterThanOrEqual(3)
  })
})
