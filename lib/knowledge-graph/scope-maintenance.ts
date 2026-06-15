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

/** One node's membership in the structural scopes implied by a provider + its depts. */
export interface ScopeMembershipEntry {
  nodeId: string
  provider: string
  departmentIds: string[]
}

/**
 * Core membership upsert shared by the incremental path (P6-3) and the backfill
 * (P6-4). Ensures every implied scope (org → each vertical → each app; each dept)
 * exists with its parent link — each ensured at most once per call — then upserts
 * one membership row per (node, scope). A node may appear under multiple providers
 * (cross-source entity); each contributes its app/vertical memberships. Non-fatal.
 */
export async function applyScopeMemberships(
  orgId: string,
  entries: ScopeMembershipEntry[],
  opts?: { departmentNames?: Record<string, string> },
): Promise<void> {
  if (!orgId || entries.length === 0) return
  try {
    const orgScopeId = await ensureScope(orgId, ORG_SCOPE, null)
    if (!orgScopeId) return // no org scope → cannot parent anything; bail (rebuild repairs)

    // Ensure each distinct scope once; cache descriptor (level:key) → scope id.
    const scopeIdCache = new Map<string, string | null>([[`org:root`, orgScopeId]])
    const ensureCached = async (d: ScopeDescriptor, parentId: string | null): Promise<string | null> => {
      const k = `${d.level}:${d.key}`
      if (scopeIdCache.has(k)) return scopeIdCache.get(k)!
      const id = await ensureScope(orgId, d, parentId)
      scopeIdCache.set(k, id)
      return id
    }

    // Pre-ensure app/vertical per distinct provider (vertical first, for parenting).
    const providers = [...new Set(entries.map((e) => e.provider).filter(Boolean))]
    for (const provider of providers) {
      const vDesc = verticalScope(provider)
      const vId = vDesc ? await ensureCached(vDesc, orgScopeId) : null
      const aDesc = appScope(provider)
      if (aDesc) await ensureCached(aDesc, vId ?? orgScopeId)
    }
    // Pre-ensure distinct departments (parent = org).
    for (const deptId of new Set(entries.flatMap((e) => e.departmentIds).filter(Boolean))) {
      await ensureCached(departmentScope(deptId, opts?.departmentNames?.[deptId]), orgScopeId)
    }

    // Build membership rows: each entry → its app, vertical, and dept scopes.
    const seen = new Set<string>()
    const rows: Array<{ org_id: string; scope_id: string; node_id: string; weight: number }> = []
    const addMember = (scopeId: string | null | undefined, nodeId: string) => {
      if (!scopeId) return
      const k = `${scopeId}:${nodeId}`
      if (seen.has(k)) return
      seen.add(k)
      rows.push({ org_id: orgId, scope_id: scopeId, node_id: nodeId, weight: 1 })
    }
    for (const e of entries) {
      const vDesc = verticalScope(e.provider)
      const aDesc = appScope(e.provider)
      if (aDesc) addMember(scopeIdCache.get(`app:${aDesc.key}`), e.nodeId)
      if (vDesc) addMember(scopeIdCache.get(`vertical:${vDesc.key}`), e.nodeId)
      for (const deptId of e.departmentIds) addMember(scopeIdCache.get(`department:${deptId}`), e.nodeId)
    }
    if (rows.length === 0) return

    const { error } = await supabaseAdmin
      .from('kg_scope_members')
      .upsert(rows, { onConflict: 'scope_id,node_id' })
    if (error) {
      logger.warn({ orgId, count: rows.length, err: error.message }, '[scope-maintenance] member upsert failed')
    }
  } catch (err) {
    logger.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      '[scope-maintenance] non-fatal failure (rebuild will repair)',
    )
  }
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

  const entries: ScopeMembershipEntry[] = []
  for (const n of nodes) {
    const id = nodeIdMap.get(nodeKey(n.label, n.entity_type))
    if (id) entries.push({ nodeId: id, provider, departmentIds: n.department_ids ?? [] })
  }
  await applyScopeMemberships(orgId, entries, opts)
}
