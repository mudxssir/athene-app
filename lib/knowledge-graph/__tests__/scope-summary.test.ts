// ============================================================
// lib/knowledge-graph/__tests__/scope-summary.test.ts — P6-6
//
// The summary engine: gather (top-K + visibility filter + input_hash stability),
// summarizeScope (empty / generated / unchanged), dirty-scope ordering, the
// reader, and the deduped enqueue. supabase + LLM + qstash mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { dbResponses, inserts, updates, invokeMock, publishJSON } = vi.hoisted(() => ({
  dbResponses: [] as Array<{ data?: unknown; error?: unknown }>,
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  invokeMock: vi.fn(),
  publishJSON: vi.fn(() => Promise.resolve({ messageId: 'm' })),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/config/feature-flags', () => ({ HIERARCHY_SCOPES: true }))
vi.mock('@/lib/qstash/client', () => ({ qstash: { publishJSON } }))
vi.mock('@/lib/langgraph/llm-factory', () => ({ resolveModelClient: vi.fn(async () => ({ invoke: invokeMock })) }))

vi.mock('@/lib/supabase/server', () => {
  const next = () => dbResponses.shift() ?? { data: null, error: null }
  const make = () => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'neq', 'not']) b[m] = vi.fn(() => b)
    b.insert = vi.fn((p: Record<string, unknown>) => { inserts.push(p); return b })
    b.update = vi.fn((p: Record<string, unknown>) => { updates.push(p); return b })
    b.maybeSingle = vi.fn(() => Promise.resolve(next()))
    b.single = vi.fn(() => Promise.resolve(next()))
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next()).then(res, rej)
    return b
  }
  return { supabaseAdmin: { from: vi.fn(() => make()) } }
})

import {
  gatherScopeInputs,
  summarizeScope,
  selectDirtyScopes,
  loadLatestScopeSummary,
  enqueueScopeSummary,
  type ScopeRow,
} from '@/lib/knowledge-graph/scope-summary'

const ORG = 'org-1'
const appScope: ScopeRow = { id: 'app-1', level: 'app', key: 'jira', title: 'Jira' }

// A full gather (4 reads): members, nodes, edges, childScopes.
function pushGather(opts?: { confidentialNode?: boolean }) {
  dbResponses.push({ data: [{ node_id: 'n1', weight: 2 }, { node_id: 'n2', weight: 1 }], error: null })
  dbResponses.push({
    data: [
      { id: 'n1', label: 'Login', entity_type: 'project', description: 'auth', visibility: 'department', department_ids: ['d1'] },
      { id: 'n2', label: 'Billing', entity_type: 'service', description: null, visibility: opts?.confidentialNode ? 'confidential' : 'department', department_ids: ['d1'] },
    ],
    error: null,
  })
  dbResponses.push({ data: [{ source_node: 'n1', target_node: 'n2', relation: 'BLOCKS' }], error: null })
  dbResponses.push({ data: [], error: null }) // no child scopes
}

beforeEach(() => {
  vi.clearAllMocks()
  dbResponses.length = 0
  inserts.length = 0
  updates.length = 0
})

describe('gatherScopeInputs (P6-6)', () => {
  it('builds context from members/edges and is input_hash-stable', async () => {
    pushGather()
    const a = await gatherScopeInputs(ORG, appScope)
    pushGather()
    const b = await gatherScopeInputs(ORG, appScope)
    expect(a?.memberCount).toBe(2)
    expect(a?.context.members.map((m) => m.label)).toEqual(['Login', 'Billing'])
    expect(a?.context.blockers).toHaveLength(1)
    expect(a?.inputHash).toBe(b?.inputHash) // deterministic
  })

  it('excludes confidential nodes from a structural scope', async () => {
    pushGather({ confidentialNode: true })
    const g = await gatherScopeInputs(ORG, appScope)
    expect(g?.context.members.map((m) => m.label)).toEqual(['Login']) // Billing dropped
  })

  it('filters department scopes to nodes in that department', async () => {
    dbResponses.push({ data: [{ node_id: 'n1', weight: 1 }, { node_id: 'n2', weight: 1 }], error: null })
    dbResponses.push({
      data: [
        { id: 'n1', label: 'A', entity_type: 'x', description: null, visibility: 'department', department_ids: ['d1'] },
        { id: 'n2', label: 'B', entity_type: 'x', description: null, visibility: 'department', department_ids: ['d2'] },
      ],
      error: null,
    })
    dbResponses.push({ data: [], error: null }) // edges
    dbResponses.push({ data: [], error: null }) // children
    const g = await gatherScopeInputs(ORG, { id: 's', level: 'department', key: 'd1', title: 'Eng' })
    expect(g?.context.members.map((m) => m.label)).toEqual(['A'])
  })

  it('returns null when the scope has no members', async () => {
    dbResponses.push({ data: [], error: null })
    expect(await gatherScopeInputs(ORG, appScope)).toBeNull()
  })
})

describe('summarizeScope (P6-6)', () => {
  it('generates a new version when there is no prior summary', async () => {
    pushGather()
    dbResponses.push({ data: null, error: null }) // latestSummaryMeta → none
    invokeMock.mockResolvedValueOnce({ content: JSON.stringify({ overview: 'Jira work in flight.', rating: 7 }) })
    dbResponses.push({ error: null }) // insert
    dbResponses.push({ error: null }) // freshness update

    expect(await summarizeScope(ORG, appScope)).toBe('generated')
    expect(inserts[0]).toMatchObject({ scope_id: 'app-1', version: 1, summary: 'Jira work in flight.' })
    expect((inserts[0].highlights as { rating: number }).rating).toBe(7)
  })

  it('skips (unchanged) when the input_hash matches the latest summary', async () => {
    pushGather()
    const g = await gatherScopeInputs(ORG, appScope) // capture the hash
    pushGather()
    dbResponses.push({ data: { version: 3, input_hash: g!.inputHash }, error: null }) // latest matches
    const result = await summarizeScope(ORG, appScope)
    expect(result).toBe('unchanged')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(0)
  })

  it('returns empty when there is nothing to summarize', async () => {
    dbResponses.push({ data: [], error: null }) // no members
    expect(await summarizeScope(ORG, appScope)).toBe('empty')
  })

  it('returns error on unparseable model output (no insert)', async () => {
    pushGather()
    dbResponses.push({ data: null, error: null }) // latest none
    invokeMock.mockResolvedValueOnce({ content: 'I cannot do that' })
    expect(await summarizeScope(ORG, appScope)).toBe('error')
    expect(inserts).toHaveLength(0)
  })
})

describe('selectDirtyScopes (P6-6)', () => {
  it('returns scopes needing refresh, ordered bottom-up (children first)', async () => {
    dbResponses.push({
      data: [
        { id: 'org-s', level: 'org', key: 'root', title: 'Org', updated_at: '2026-06-15T10:00:00Z' },
        { id: 'comm-s', level: 'community', key: 'jira#n1', title: 'C', updated_at: '2026-06-15T10:00:00Z' },
      ],
      error: null,
    })
    dbResponses.push({ data: null, error: null }) // org-s: no summary → dirty
    dbResponses.push({ data: null, error: null }) // comm-s: no summary → dirty
    const dirty = await selectDirtyScopes(ORG)
    expect(dirty.map((s) => s.level)).toEqual(['community', 'org']) // community (rank 0) first
  })

  it('skips scopes whose summary is newer than their updated_at', async () => {
    dbResponses.push({ data: [{ id: 's1', level: 'app', key: 'jira', title: 'J', updated_at: '2026-06-15T10:00:00Z' }], error: null })
    dbResponses.push({ data: { created_at: '2026-06-15T11:00:00Z' }, error: null }) // summary newer → clean
    expect(await selectDirtyScopes(ORG)).toEqual([])
  })
})

describe('loadLatestScopeSummary + enqueue (P6-6)', () => {
  it('reads the latest summary for a scope', async () => {
    dbResponses.push({ data: { id: 'app-1' }, error: null }) // scope lookup
    dbResponses.push({ data: { summary: 'S', highlights: { overview: 'S', rating: 5 }, version: 2 }, error: null })
    const r = await loadLatestScopeSummary(ORG, 'app', 'jira')
    expect(r).toMatchObject({ summary: 'S', version: 2 })
  })

  it('returns null when the scope or summary is missing', async () => {
    dbResponses.push({ data: null, error: null })
    expect(await loadLatestScopeSummary(ORG, 'app', 'ghost')).toBeNull()
  })

  describe('enqueueScopeSummary', () => {
    const prev = process.env.NEXT_PUBLIC_APP_URL
    beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com' })
    afterEach(() => { if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = prev })

    it('publishes a deduped refresh', () => {
      enqueueScopeSummary(ORG)
      expect(publishJSON).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://app.example.com/api/worker/scope-summary',
        deduplicationId: `org:scope-summary:${ORG}`,
      }))
    })
  })
})
