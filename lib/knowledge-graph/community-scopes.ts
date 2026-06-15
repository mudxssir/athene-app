// ============================================================
// lib/knowledge-graph/community-scopes.ts — P6-5 (PLAN_C §3 step 3)
//
// L1 communities *per app scope*: for each app scope, take its member nodes +
// the edges among them, run the (interim) Louvain partition, and materialize
// each non-trivial cluster as a community-level kg_scope (parent = the app scope)
// with its own memberships. Communities feed the bottom-up summaries (P6-6).
//
// Interim engine = graphology Louvain (community.ts `louvainPartition`). The
// playbook A-vs-B verdict keeps Louvain on the flat graph until the graspologic
// **Leiden** sidecar lane (`/graph/leiden`, hierarchical partitions) passes a
// modularity + briefing-output parity test — then Louvain is retired. Swapping
// engines is localized to the `louvainPartition` call here. (Leiden lane = the
// one infra-gated P6 follow-up; see P6_TRACKER.)
//
// SERVICE-ROLE JUSTIFICATION: org-wide post-backfill / debounced batch job (no
// RLS session); reads the full app subgraph and writes kg_scopes/kg_scope_members
// (SELECT-only RLS, service-role writes like kg_node_aliases backfill). Org-scoped
// by explicit org_id; no chunk/content text read or logged.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { louvainPartition, type PartitionEdge } from './community'
import { communityScope } from './scope-registry'

const PAGE = 5_000
/** Clusters smaller than this are noise — not worth a scope/summary. */
export const MIN_COMMUNITY_SIZE = 3

interface AppScopeRow { id: string; key: string }

async function loadAppScopes(orgId: string): Promise<AppScopeRow[]> {
  const { data, error } = await supabaseAdmin
    .from('kg_scopes')
    .select('id, key')
    .eq('org_id', orgId)
    .eq('level', 'app')
    .neq('status', 'torn_down')
  if (error) {
    logger.warn({ orgId, err: error.message }, '[community-scopes] app scope load failed')
    return []
  }
  return (data ?? []) as AppScopeRow[]
}

async function loadMemberNodeIds(scopeId: string): Promise<string[]> {
  const out: string[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('kg_scope_members')
      .select('node_id')
      .eq('scope_id', scopeId)
      .range(offset, offset + PAGE - 1)
    if (error) {
      logger.warn({ scopeId, err: error.message }, '[community-scopes] member load failed')
      break
    }
    const rows = (data ?? []) as Array<{ node_id: string }>
    out.push(...rows.map((r) => r.node_id))
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return out
}

/** Load all org edges once (source, target, weight) — filtered per-app in memory. */
async function loadOrgEdges(orgId: string): Promise<PartitionEdge[]> {
  const out: PartitionEdge[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('kg_edges')
      .select('source_node, target_node, confidence')
      .eq('org_id', orgId)
      .range(offset, offset + PAGE - 1)
    if (error) {
      logger.warn({ orgId, err: error.message }, '[community-scopes] edge load failed')
      break
    }
    const rows = (data ?? []) as Array<{ source_node: string; target_node: string; confidence: number | null }>
    for (const r of rows) out.push({ source: r.source_node, target: r.target_node, weight: r.confidence ?? 1 })
    if (rows.length < PAGE) break
    offset += PAGE
  }
  return out
}

async function upsertCommunityScope(
  orgId: string, provider: string, communityId: string, parentAppScopeId: string,
): Promise<string | null> {
  const d = communityScope(provider, communityId)
  const { data, error } = await supabaseAdmin
    .from('kg_scopes')
    .upsert(
      { org_id: orgId, level: 'community', key: d.key, title: d.title, parent_scope_id: parentAppScopeId, updated_at: new Date().toISOString() },
      { onConflict: 'org_id,level,key' },
    )
    .select('id')
    .single()
  if (error || !data) {
    logger.warn({ orgId, key: d.key, err: error?.message }, '[community-scopes] community scope upsert failed')
    return null
  }
  return data.id as string
}

/** Drop community scopes under an app whose key is not in the current partition. */
async function pruneStaleCommunities(orgId: string, parentAppScopeId: string, keepKeys: string[]): Promise<void> {
  let q = supabaseAdmin
    .from('kg_scopes')
    .delete()
    .eq('org_id', orgId)
    .eq('level', 'community')
    .eq('parent_scope_id', parentAppScopeId)
  if (keepKeys.length > 0) {
    // Postgrest `not in` list — quote each key.
    q = q.not('key', 'in', `(${keepKeys.map((k) => `"${k}"`).join(',')})`)
  }
  const { error } = await q
  if (error) logger.warn({ orgId, err: error.message }, '[community-scopes] prune failed (non-fatal)')
}

export interface CommunityBuildSummary { appsProcessed: number; communitiesCreated: number }

/**
 * (Re)build community scopes for every app scope of an org. Idempotent: community
 * keys are stable (`${provider}#${lowestNodeId}`), member upserts are PK-idempotent,
 * and stale communities are pruned — so two runs converge to the same set.
 */
export async function buildCommunityScopes(orgId: string): Promise<CommunityBuildSummary> {
  const summary: CommunityBuildSummary = { appsProcessed: 0, communitiesCreated: 0 }
  if (!orgId) return summary

  const appScopes = await loadAppScopes(orgId)
  if (appScopes.length === 0) return summary
  const allEdges = await loadOrgEdges(orgId)

  for (const app of appScopes) {
    const memberIds = await loadMemberNodeIds(app.id)
    if (memberIds.length < MIN_COMMUNITY_SIZE) {
      await pruneStaleCommunities(orgId, app.id, [])
      continue
    }
    summary.appsProcessed++

    // Induced subgraph: edges with both endpoints in this app's members.
    const memberSet = new Set(memberIds)
    const subEdges = allEdges.filter((e) => memberSet.has(e.source) && memberSet.has(e.target))
    const communities = louvainPartition(memberIds, subEdges).filter((c) => c.memberIds.length >= MIN_COMMUNITY_SIZE)

    const keptKeys: string[] = []
    for (const c of communities) {
      const scopeId = await upsertCommunityScope(orgId, app.key, c.communityId, app.id)
      if (!scopeId) continue
      keptKeys.push(communityScope(app.key, c.communityId).key)
      const rows = c.memberIds.map((nodeId) => ({ org_id: orgId, scope_id: scopeId, node_id: nodeId, weight: 1 }))
      const { error } = await supabaseAdmin.from('kg_scope_members').upsert(rows, { onConflict: 'scope_id,node_id' })
      if (error) logger.warn({ orgId, scopeId, err: error.message }, '[community-scopes] community member upsert failed')
      else summary.communitiesCreated++
    }
    // Remove communities that no longer exist (drift after re-clustering).
    await pruneStaleCommunities(orgId, app.id, keptKeys)
  }

  logger.info(summary, '[community-scopes] rebuild complete')
  return summary
}
