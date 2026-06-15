// ============================================================
// lib/knowledge-graph/__tests__/scope-backfill.test.ts — P6-4
//
// Paged backfill: resolves provider(s) per node from source_documents →
// documents.source_type, emits one membership entry per (node, distinct
// provider), and pages by node-id cursor. Plus teardown + enqueue. applyScope-
// Memberships, supabase, and qstash are mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { dbResponses, deleteCalls, applyMock, publishJSON } = vi.hoisted(() => ({
  dbResponses: [] as Array<{ data?: unknown; error?: unknown }>,
  deleteCalls: [] as string[],
  applyMock: vi.fn(() => Promise.resolve()),
  publishJSON: vi.fn(() => Promise.resolve({ messageId: 'm' })),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/config/feature-flags', () => ({ HIERARCHY_SCOPES: true }))
vi.mock('@/lib/qstash/client', () => ({ qstash: { publishJSON } }))
vi.mock('@/lib/knowledge-graph/scope-maintenance', () => ({ applyScopeMemberships: applyMock }))

vi.mock('@/lib/supabase/server', () => {
  const next = () => dbResponses.shift() ?? { data: [], error: null }
  const makeBuilder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gt', 'order', 'limit', 'in']) b[m] = vi.fn(() => b)
    b.delete = vi.fn(() => {
      const d: Record<string, unknown> = {}
      d.eq = vi.fn((_c: string, orgId: string) => { deleteCalls.push(`${table}:${orgId}`); return Promise.resolve({ error: null }) })
      return d
    })
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve, reject)
    return b
  }
  return { supabaseAdmin: { from: vi.fn((t: string) => makeBuilder(t)) } }
})

import {
  backfillScopeMembershipsPage,
  clearScopeMemberships,
  enqueueScopeBackfill,
  NODE_PAGE,
} from '@/lib/knowledge-graph/scope-backfill'

const ORG = 'org-1'

beforeEach(() => {
  vi.clearAllMocks()
  dbResponses.length = 0
  deleteCalls.length = 0
})

describe('backfillScopeMembershipsPage (P6-4)', () => {
  it('emits one entry per (node, distinct provider) resolved from source docs', async () => {
    dbResponses.push({
      data: [
        { id: 'n1', department_ids: ['d1'], source_documents: ['doc1', 'doc2'] },
        { id: 'n2', department_ids: [], source_documents: ['doc3'] },
      ],
      error: null,
    })
    dbResponses.push({
      data: [
        { id: 'doc1', source_type: 'jira' },
        { id: 'doc2', source_type: 'jira' },   // same provider → deduped per node
        { id: 'doc3', source_type: 'slack' },
      ],
      error: null,
    })
    const res = await backfillScopeMembershipsPage(ORG, '', 200)
    expect(res.processed).toBe(2)
    const entries = applyMock.mock.calls[0][1]
    expect(entries).toEqual([
      { nodeId: 'n1', provider: 'jira', departmentIds: ['d1'] },
      { nodeId: 'n2', provider: 'slack', departmentIds: [] },
    ])
  })

  it('returns nextCursor=last id on a full page, null on a partial page', async () => {
    // Full page (limit 2 → 2 rows): nextCursor = last id.
    dbResponses.push({ data: [{ id: 'a', source_documents: [] }, { id: 'b', source_documents: [] }], error: null })
    // no docIds → no documents query
    const full = await backfillScopeMembershipsPage(ORG, '', 2)
    expect(full.nextCursor).toBe('b')

    // Partial page (1 row < limit 2): done.
    dbResponses.push({ data: [{ id: 'c', source_documents: [] }], error: null })
    const partial = await backfillScopeMembershipsPage(ORG, 'b', 2)
    expect(partial.nextCursor).toBeNull()
  })

  it('no-ops cleanly on an empty page', async () => {
    dbResponses.push({ data: [], error: null })
    expect(await backfillScopeMembershipsPage(ORG, '')).toEqual({ processed: 0, nextCursor: null })
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('handles a node whose source docs have no resolvable provider', async () => {
    dbResponses.push({ data: [{ id: 'n1', department_ids: [], source_documents: ['gone'] }], error: null })
    dbResponses.push({ data: [], error: null }) // no provider for 'gone'
    const res = await backfillScopeMembershipsPage(ORG, '')
    expect(res.processed).toBe(1)
    // No entries → applyScopeMemberships not called.
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('bails on a node-read error', async () => {
    dbResponses.push({ data: null, error: { message: 'boom' } })
    expect(await backfillScopeMembershipsPage(ORG, '')).toEqual({ processed: 0, nextCursor: null })
  })

  it('NODE_PAGE is a sane default', () => {
    expect(NODE_PAGE).toBeGreaterThanOrEqual(50)
  })
})

describe('clearScopeMemberships (P6-4)', () => {
  it('deletes the org\'s memberships', async () => {
    await clearScopeMemberships(ORG)
    expect(deleteCalls).toContain(`kg_scope_members:${ORG}`)
  })
})

describe('enqueueScopeBackfill (P6-4)', () => {
  const prev = process.env.NEXT_PUBLIC_APP_URL
  beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com' })
  afterEach(() => { if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = prev })

  it('publishes a deduped paging job', () => {
    enqueueScopeBackfill(ORG, 'cursor-x')
    expect(publishJSON).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://app.example.com/api/worker/scope-backfill',
      body: { org_id: ORG, cursor: 'cursor-x' },
      retries: 3,
      deduplicationId: `org:scope-backfill:${ORG}:cursor-x`,
    }))
  })

  it('uses a "start" dedup id for the first page', () => {
    enqueueScopeBackfill(ORG)
    expect(publishJSON).toHaveBeenCalledWith(expect.objectContaining({
      deduplicationId: `org:scope-backfill:${ORG}:start`,
    }))
  })

  it('no-ops for an empty org', () => {
    enqueueScopeBackfill('')
    expect(publishJSON).not.toHaveBeenCalled()
  })
})
