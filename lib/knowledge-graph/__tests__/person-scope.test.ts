// ============================================================
// lib/knowledge-graph/__tests__/person-scope.test.ts — P6-7
//
// Person scopes: collect the 2-hop work nodes, materialize (rebuild memberships
// from the live my-work BFS), the stale sweep, and the canary drift check.
// getMyWork, supabase, qstash + the summary enqueue are mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { dbResponses, scopeUpserts, memberUpserts, deletes, updates, getMyWorkMock } = vi.hoisted(() => ({
  dbResponses: [] as Array<{ data?: unknown; error?: unknown }>,
  scopeUpserts: [] as Array<Record<string, unknown>>,
  memberUpserts: [] as Array<Array<Record<string, unknown>>>,
  deletes: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
  getMyWorkMock: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/config/feature-flags', () => ({ HIERARCHY_SCOPES: true }))
vi.mock('@/lib/qstash/client', () => ({ qstash: { publishJSON: vi.fn(() => Promise.resolve({ messageId: 'm' })) } }))
vi.mock('@/lib/knowledge-graph/my-work', () => ({ getMyWork: getMyWorkMock }))
vi.mock('@/lib/knowledge-graph/scope-summary', () => ({ enqueueScopeSummary: vi.fn() }))

vi.mock('@/lib/supabase/server', () => {
  const next = () => dbResponses.shift() ?? { data: null, error: null }
  const make = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'lt', 'limit', 'in', 'neq']) b[m] = vi.fn(() => b)
    b.delete = vi.fn(() => { deletes.push(table); return b })
    b.update = vi.fn((p: Record<string, unknown>) => { updates.push(p); return b })
    b.upsert = vi.fn((p: unknown) => {
      if (table === 'kg_scope_members') memberUpserts.push(p as Array<Record<string, unknown>>)
      else if (table === 'kg_scopes') scopeUpserts.push(p as Record<string, unknown>)
      return b
    })
    b.maybeSingle = vi.fn(() => Promise.resolve(next()))
    b.single = vi.fn(() => Promise.resolve(next()))
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next()).then(res, rej)
    return b
  }
  return { supabaseAdmin: { from: vi.fn((t: string) => make(t)) } }
})

import {
  collectWorkNodeIds,
  materializePersonScope,
  sweepStalePersonScopes,
  canaryCheck,
} from '@/lib/knowledge-graph/person-scope'

const ORG = 'org-1'
const MEMBER = 'member-1'
const memberRow = { id: MEMBER, display_name: 'Dana', email: 'dana@acme.com', department_id: 'd1', role: 'member' }

const work = (extra: { person?: boolean } = {}) => ({
  person: extra.person === false ? null : { id: 'p1' },
  items: [{ node: { id: 'i1' }, url: null, blockers: [{ node: { id: 'b1' }, upstream: [{ node: { id: 'b2' } }] }] }],
})

beforeEach(() => {
  vi.clearAllMocks()
  dbResponses.length = 0
  scopeUpserts.length = 0
  memberUpserts.length = 0
  deletes.length = 0
  updates.length = 0
})

describe('collectWorkNodeIds (P6-7)', () => {
  it('collects person + items + 2-hop blockers, deduped', () => {
    expect(collectWorkNodeIds(work() as never).sort()).toEqual(['b1', 'b2', 'i1', 'p1'])
  })
  it('handles an empty work graph', () => {
    expect(collectWorkNodeIds({ person: null, items: [] } as never)).toEqual([])
  })
})

describe('materializePersonScope (P6-7)', () => {
  it('rebuilds the person scope memberships from the live BFS', async () => {
    dbResponses.push({ data: memberRow, error: null })   // loadMember
    getMyWorkMock.mockResolvedValueOnce(work())
    dbResponses.push({ data: { id: 'org-scope' }, error: null }) // ensureOrgScopeId
    dbResponses.push({ data: { id: 'person-scope' }, error: null }) // person scope upsert
    dbResponses.push({ error: null }) // delete members
    dbResponses.push({ error: null }) // member upsert

    const res = await materializePersonScope(ORG, MEMBER)
    expect(res).toEqual({ memberCount: 4 })
    // Person scope upserted with member as key + org parent + 7d stale window.
    const personUpsert = scopeUpserts.find((s) => s.level === 'person')
    expect(personUpsert).toMatchObject({ key: MEMBER, parent_scope_id: 'org-scope', status: 'active' })
    expect(personUpsert?.stale_after).toBeTruthy()
    // Members replaced (delete then upsert the 4 nodes).
    expect(deletes).toContain('kg_scope_members')
    expect(memberUpserts[0].map((r) => r.node_id).sort()).toEqual(['b1', 'b2', 'i1', 'p1'])
  })

  it('returns null when the member is missing', async () => {
    dbResponses.push({ data: null, error: null })
    expect(await materializePersonScope(ORG, MEMBER)).toBeNull()
  })

  it('returns null when the member has no person node yet', async () => {
    dbResponses.push({ data: memberRow, error: null })
    getMyWorkMock.mockResolvedValueOnce(work({ person: false }))
    expect(await materializePersonScope(ORG, MEMBER)).toBeNull()
    expect(scopeUpserts).toHaveLength(0)
  })
})

describe('sweepStalePersonScopes (P6-7)', () => {
  it('marks stale scopes and deletes their derived rows', async () => {
    dbResponses.push({ data: [{ id: 'ps1' }], error: null }) // stale select
    dbResponses.push({ error: null }) // delete members
    dbResponses.push({ error: null }) // delete summaries
    dbResponses.push({ error: null }) // update status
    const res = await sweepStalePersonScopes(ORG)
    expect(res).toEqual({ swept: 1 })
    expect(deletes).toEqual(['kg_scope_members', 'kg_scope_summaries'])
    expect(updates[0]).toMatchObject({ status: 'stale' })
  })

  it('no-ops when nothing is stale', async () => {
    dbResponses.push({ data: [], error: null })
    expect(await sweepStalePersonScopes(ORG)).toEqual({ swept: 0 })
  })
})

describe('canaryCheck (P6-7)', () => {
  it('reports zero drift when materialized == live', async () => {
    dbResponses.push({ data: [{ id: 'ps1', key: MEMBER }], error: null }) // person scopes
    dbResponses.push({ data: memberRow, error: null }) // loadMember
    dbResponses.push({ data: [{ node_id: 'p1' }, { node_id: 'i1' }, { node_id: 'b1' }, { node_id: 'b2' }], error: null }) // materialized
    getMyWorkMock.mockResolvedValueOnce(work()) // live = p1,i1,b1,b2
    const res = await canaryCheck(ORG)
    expect(res).toMatchObject({ checked: 1, maxDrift: 0, drifted: 0 })
  })

  it('flags drift when materialized diverges from live', async () => {
    dbResponses.push({ data: [{ id: 'ps1', key: MEMBER }], error: null })
    dbResponses.push({ data: memberRow, error: null })
    dbResponses.push({ data: [{ node_id: 'stale-only' }], error: null }) // materialized differs entirely
    getMyWorkMock.mockResolvedValueOnce(work())
    const res = await canaryCheck(ORG)
    expect(res.checked).toBe(1)
    expect(res.maxDrift).toBeGreaterThan(0.2)
    expect(res.drifted).toBe(1)
  })
})
