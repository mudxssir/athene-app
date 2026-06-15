// ============================================================
// lib/langgraph/tools/__tests__/get-scope-summary.test.ts — P6-9
//
// The get_scope_summary tool: flag gate, missing-context guard, RLS-read of the
// latest summary (formatted), and the not-found / no-summary messages.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { flag, tableData } = vi.hoisted(() => ({
  flag: { on: true },
  tableData: { scope: null as unknown, summary: null as unknown },
}))

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/config/feature-flags', () => ({ get HIERARCHY_SCOPES() { return flag.on } }))

vi.mock('@/lib/supabase/rls-client', () => ({
  withRLS: (_ctx: unknown, cb: (s: unknown) => unknown) => cb({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain
      chain.maybeSingle = () => Promise.resolve({
        data: table === 'kg_scopes' ? tableData.scope : tableData.summary,
        error: null,
      })
      return chain
    },
  }),
}))

import { scopeSummaryTool } from '@/lib/langgraph/tools/get-scope-summary'

const config = { configurable: { orgId: 'org-1', userId: 'user-1', role: 'member', deptId: 'd1' } }

beforeEach(() => {
  flag.on = true
  tableData.scope = { id: 'scope-1', title: 'Engineering' }
  tableData.summary = {
    summary: 'Engineering is shipping the billing migration.',
    highlights: {
      key_entities: ['API Gateway', 'Billing'],
      active_blockers: [{ from: 'Vendor API', to: 'Billing', owner: 'Dana' }],
      open_obligations: ['Migrate prod'],
    },
  }
})

describe('get_scope_summary tool (P6-9)', () => {
  it('returns a disabled message when the flag is off', async () => {
    flag.on = false
    expect(await scopeSummaryTool.invoke({ level: 'department', key: 'd1' }, config)).toBe('Scope summaries are not enabled.')
  })

  it('guards missing org context', async () => {
    const out = await scopeSummaryTool.invoke({ level: 'org', key: 'root' }, { configurable: {} })
    expect(out).toContain('missing org context')
  })

  it('formats the latest summary with entities, blockers, and obligations', async () => {
    const out = await scopeSummaryTool.invoke({ level: 'department', key: 'd1' }, config)
    expect(out).toContain('[Engineering]')
    expect(out).toContain('billing migration')
    expect(out).toContain('Key entities: API Gateway, Billing')
    expect(out).toContain('Billing ← Vendor API (owner Dana)')
    expect(out).toContain('Open obligations: Migrate prod')
  })

  it('reports when the scope is not readable/absent', async () => {
    tableData.scope = null
    expect(await scopeSummaryTool.invoke({ level: 'department', key: 'secret' }, config)).toContain('No department scope')
  })

  it('reports when no summary has been generated yet', async () => {
    tableData.summary = null
    expect(await scopeSummaryTool.invoke({ level: 'app', key: 'jira' }, config)).toContain('No summary has been generated yet')
  })
})
