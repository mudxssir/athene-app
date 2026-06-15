// ============================================================
// lib/knowledge-graph/__tests__/blocker-matrix.test.ts — P6-8
//
// Reader: dept-name enrichment + sort + unowned count from the RPCs; and the
// pure team-blocked watchlist evaluation.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpcMock, deptRows } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  deptRows: { value: [] as Array<{ id: string; name: string }> },
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: {
    rpc: rpcMock,
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: deptRows.value, error: null }) }) }),
  },
}))

import {
  getBlockerMatrix,
  evaluateTeamBlockedWatchlist,
  BLOCKER_WATCHLIST_TEMPLATE,
  type BlockerMatrix,
} from '@/lib/knowledge-graph/blocker-matrix'

beforeEach(() => {
  vi.clearAllMocks()
  deptRows.value = [{ id: 'eng', name: 'Engineering' }, { id: 'sales', name: 'Sales' }]
})

describe('getBlockerMatrix (P6-8)', () => {
  it('enriches dept names, sorts by open_blockers desc, and reads the unowned count', async () => {
    rpcMock.mockImplementation((fn: string, _args: unknown) => {
      if (fn === 'blocker_dept_matrix') {
        return Promise.resolve({ data: [
          { blocking_dept: 'eng', waiting_dept: 'sales', open_blockers: 2 },
          { blocking_dept: 'sales', waiting_dept: 'eng', open_blockers: 5 },
        ], error: null })
      }
      return Promise.resolve({ data: 3, error: null }) // unowned_blocker_count
    })

    const m = await getBlockerMatrix('org-1')
    expect(m.unowned_blockers).toBe(3)
    expect(m.rows.map((r) => r.open_blockers)).toEqual([5, 2]) // sorted desc
    expect(m.rows[0]).toMatchObject({ blocking_dept_name: 'Sales', waiting_dept_name: 'Engineering' })
  })

  it('returns empty on an RPC error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } })
    expect(await getBlockerMatrix('org-1')).toEqual({ rows: [], unowned_blockers: 0 })
  })

  it('labels unknown departments rather than dropping rows', async () => {
    deptRows.value = []
    rpcMock.mockImplementation((fn: string) =>
      fn === 'blocker_dept_matrix'
        ? Promise.resolve({ data: [{ blocking_dept: 'x', waiting_dept: 'y', open_blockers: 1 }], error: null })
        : Promise.resolve({ data: 0, error: null }))
    const m = await getBlockerMatrix('org-1')
    expect(m.rows[0]).toMatchObject({ blocking_dept_name: 'Unknown', waiting_dept_name: 'Unknown' })
  })
})

describe('evaluateTeamBlockedWatchlist (P6-8)', () => {
  const matrix: BlockerMatrix = {
    unowned_blockers: 0,
    rows: [
      { blocking_dept: 'sales', waiting_dept: 'eng', blocking_dept_name: 'Sales', waiting_dept_name: 'Engineering', open_blockers: 5 },
      { blocking_dept: 'ops', waiting_dept: 'eng', blocking_dept_name: 'Ops', waiting_dept_name: 'Engineering', open_blockers: 2 },
      { blocking_dept: 'eng', waiting_dept: 'sales', blocking_dept_name: 'Engineering', waiting_dept_name: 'Sales', open_blockers: 1 },
    ],
  }

  it('returns the departments blocking my team, most blockers first', () => {
    const alerts = evaluateTeamBlockedWatchlist(matrix, 'eng')
    expect(alerts.map((a) => a.blocking_dept)).toEqual(['sales', 'ops'])
    expect(alerts[0]).toMatchObject({ blocking_dept_name: 'Sales', open_blockers: 5 })
  })

  it('is empty when my team is not cross-dept blocked, or no dept given', () => {
    expect(evaluateTeamBlockedWatchlist(matrix, 'ops')).toEqual([])
    expect(evaluateTeamBlockedWatchlist(matrix, '')).toEqual([])
  })

  it('the template names department_id as its param', () => {
    expect(BLOCKER_WATCHLIST_TEMPLATE.params).toContain('department_id')
    expect(BLOCKER_WATCHLIST_TEMPLATE.key).toBe('team_blocked_by_other_dept')
  })
})
