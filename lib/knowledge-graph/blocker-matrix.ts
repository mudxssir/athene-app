// ============================================================
// lib/knowledge-graph/blocker-matrix.ts — P6-8 (PLAN_C §5)
//
// Reader for the cross-team blocker matrix + the unowned-blocker gap, plus the
// "my team blocked by another department" watchlist template. The heavy
// aggregation is the deterministic SQL (blocker_dept_matrix / unowned_blocker_count,
// 20260615000002); this enriches the rows with department names and evaluates the
// watchlist condition. Aggregate counts only — no node content.
//
// SERVICE-ROLE JUSTIFICATION: the SECURITY DEFINER RPCs return aggregate counts
// (no content); the admin route gates the caller to role=admin before calling.
// Org-scoped by the explicit p_org argument.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export interface BlockerMatrixRow {
  blocking_dept: string
  waiting_dept: string
  blocking_dept_name: string
  waiting_dept_name: string
  open_blockers: number
}

export interface BlockerMatrix {
  rows: BlockerMatrixRow[]
  unowned_blockers: number
}

/** Read + dept-name-enrich the cross-team blocker matrix for an org. */
export async function getBlockerMatrix(orgId: string): Promise<BlockerMatrix> {
  const [{ data: matrix, error: mErr }, { data: unowned }, { data: depts }] = await Promise.all([
    supabaseAdmin.rpc('blocker_dept_matrix', { p_org: orgId }),
    supabaseAdmin.rpc('unowned_blocker_count', { p_org: orgId }),
    supabaseAdmin.from('departments').select('id, name').eq('org_id', orgId),
  ])
  if (mErr) {
    logger.warn({ orgId, err: mErr.message }, '[blocker-matrix] matrix rpc failed')
    return { rows: [], unowned_blockers: 0 }
  }
  const nameById = new Map((depts ?? []).map((d) => [(d as { id: string }).id, (d as { name: string }).name]))
  const rows: BlockerMatrixRow[] = ((matrix ?? []) as Array<{ blocking_dept: string; waiting_dept: string; open_blockers: number }>)
    .map((r) => ({
      blocking_dept: r.blocking_dept,
      waiting_dept: r.waiting_dept,
      blocking_dept_name: nameById.get(r.blocking_dept) ?? 'Unknown',
      waiting_dept_name: nameById.get(r.waiting_dept) ?? 'Unknown',
      open_blockers: Number(r.open_blockers),
    }))
    .sort((a, b) => b.open_blockers - a.open_blockers)
  return { rows, unowned_blockers: Number(unowned ?? 0) }
}

// ── Watchlist template (§5.3) ────────────────────────────────────────────────

/** Template descriptor the watchlist system instantiates per team. */
export const BLOCKER_WATCHLIST_TEMPLATE = {
  key: 'team_blocked_by_other_dept',
  title: 'My team is blocked by another department',
  description:
    'Alert when one of my team\'s open items is blocked by an item owned by a ' +
    'different department (a cross-team escalation).',
  params: ['department_id'] as const,
}

export interface BlockerWatchlistAlert {
  blocking_dept: string
  blocking_dept_name: string
  open_blockers: number
}

/**
 * Pure evaluation of the team-blocked watchlist: given the matrix and the
 * watcher's department, return the other departments blocking it (waiting_dept ==
 * mine), most blockers first. Empty when the team is not cross-dept blocked.
 */
export function evaluateTeamBlockedWatchlist(matrix: BlockerMatrix, departmentId: string): BlockerWatchlistAlert[] {
  if (!departmentId) return []
  return matrix.rows
    .filter((r) => r.waiting_dept === departmentId && r.open_blockers > 0)
    .map((r) => ({ blocking_dept: r.blocking_dept, blocking_dept_name: r.blocking_dept_name, open_blockers: r.open_blockers }))
    .sort((a, b) => b.open_blockers - a.open_blockers)
}
