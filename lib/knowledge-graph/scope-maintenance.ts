// ============================================================
// lib/knowledge-graph/scope-maintenance.ts — P6-3 (PLAN_C §3.1)
//
// Incremental scope-membership maintenance, called from builder.ts after
// upsertGraph for the nodes a document just touched. For each touched node it
// upserts membership into its structural scopes (app / vertical / department),
// ensuring those scopes + their parent roll-up chain exist first. Touching a
// scope bumps its updated_at — the "dirty" signal the debounced summary worker
// (P6-6) keys on to decide which scopes to recompute.
//
// Behind HIERARCHY_SCOPES (default OFF). Non-fatal by construction: scopes are
// derivative and the backfill/rebuild (P6-4) can always repair them, so a
// maintenance failure must never fail the graph build.
//
// SERVICE-ROLE JUSTIFICATION: runs in the QStash graph-build worker (no RLS
// session). kg_scopes/kg_scope_members have SELECT-only RLS (writes are
// service-role, like kg_node_aliases backfill); every write is org-scoped by an
// explicit org_id column. No chunk/content text is written or logged here.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import { nodeKey } from './utils'
import type { KGNode } from './types'
import {
  ORG_SCOPE,
  appScope,
  verticalScope,
  departmentScope,
  type ScopeDescriptor,
} from './scope-registry'

const NOW = () => new Date().toISOString()

/**
 * Upsert one scope row (ensuring its parent link) and return its id. The
 * ON CONFLICT update bumps updated_at — the dirty signal for P6-6 — and refreshes
 * title/parent, but never touches status/stats (so a torn_down scope is not
 * silently resurrected and accumulated stats survive).
 */
async function ensureScope(orgId: string, d: ScopeDescriptor, parentId: string | null): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('kg_scopes')
    .upsert(
      { org_id: orgId, level: d.level, key: d.key, title: d.title, parent_scope_id: parentId, updated_at: NOW() },
      { onConflict: 'org_id,level,key' },
    )
    .select('id')
    .single()
  if (error || !data) {
    logger.warn({ orgId, level: d.level, key: d.key, err: error?.message }, '[scope-maintenance] ensureScope failed')
    return null
  }
  return data.id as string
}

/**
 * Maintain app/vertical/department scope memberships for the touched nodes of one
 * document. `provider` is the syncing connection's source_type; per-node
 * department_ids come from the in-memory KGNodes (joined to their upserted ids
 * via nodeIdMap). Community + person memberships are assigned elsewhere (P6-5/P6-7).
 */
export async function maintainScopeMemberships(
  orgId: string,
  provider: string,
  nodes: KGNode[],
  nodeIdMap: Map<string, string>,
  opts?: { departmentNames?: Record<string, string> },
): Promise<void> {
  if (!HIERARCHY_SCOPES || !orgId || !provider || nodes.length === 0) return

  try {
    // 1. Resolve touched nodes → ids (+ their department_ids).
    const touched: Array<{ id: string; departmentIds: string[] }> = []
    for (const n of nodes) {
      const id = nodeIdMap.get(nodeKey(n.label, n.entity_type))
      if (id) touched.push({ id, departmentIds: n.department_ids ?? [] })
    }
    if (touched.length === 0) return

    // 2. Ensure the scope skeleton (org → vertical → app; departments → org).
    const orgScopeId = await ensureScope(orgId, ORG_SCOPE, null)
    if (!orgScopeId) return // no org scope → cannot parent anything; bail (backfill repairs)

    const appDesc = appScope(provider)
    const verticalDesc = verticalScope(provider)

    let verticalId: string | null = null
    if (verticalDesc) verticalId = await ensureScope(orgId, verticalDesc, orgScopeId)

    let appId: string | null = null
    if (appDesc) appId = await ensureScope(orgId, appDesc, verticalId ?? orgScopeId)

    // Distinct departments across touched nodes → ensure each (parent = org).
    const deptIds = [...new Set(touched.flatMap((t) => t.departmentIds).filter(Boolean))]
    const deptScopeId = new Map<string, string>()
    for (const deptId of deptIds) {
      const id = await ensureScope(orgId, departmentScope(deptId, opts?.departmentNames?.[deptId]), orgScopeId)
      if (id) deptScopeId.set(deptId, id)
    }

    // 3. Build membership rows: each node → its app, vertical, and dept scopes.
    const seen = new Set<string>()
    const rows: Array<{ org_id: string; scope_id: string; node_id: string; weight: number }> = []
    const addMember = (scopeId: string | null, nodeId: string) => {
      if (!scopeId) return
      const k = `${scopeId}:${nodeId}`
      if (seen.has(k)) return
      seen.add(k)
      rows.push({ org_id: orgId, scope_id: scopeId, node_id: nodeId, weight: 1 })
    }
    for (const t of touched) {
      addMember(appId, t.id)
      addMember(verticalId, t.id)
      for (const deptId of t.departmentIds) addMember(deptScopeId.get(deptId) ?? null, t.id)
    }
    if (rows.length === 0) return

    // 4. Upsert memberships (idempotent on the PK).
    const { error } = await supabaseAdmin
      .from('kg_scope_members')
      .upsert(rows, { onConflict: 'scope_id,node_id' })
    if (error) {
      logger.warn({ orgId, count: rows.length, err: error.message }, '[scope-maintenance] member upsert failed')
    }
  } catch (err) {
    logger.warn(
      { orgId, provider, err: err instanceof Error ? err.message : String(err) },
      '[scope-maintenance] non-fatal failure (backfill will repair)',
    )
  }
}
