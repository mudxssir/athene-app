// ============================================================
// lib/knowledge-graph/person-scope.ts — P6-7 (PLAN_C §3.2)
//
// Person scopes — the freshness-TTL design. A person scope materializes the
// member's 2-hop work-graph (their items + blocker chains) as scope memberships
// by running the my-work BFS (the correctness reference) under the member's RLS,
// so the materialized set equals what a live query would return. Freshness:
// stale_after = now()+7d, bumped on activity; a daily sweep marks past-stale
// scopes `stale` and deletes their member + summary rows (staleness must never
// masquerade as truth). A nightly canary re-runs the BFS for N random scopes and
// alerts on drift — the guard against membership-maintenance bugs.
//
// SERVICE-ROLE JUSTIFICATION: background materialize/sweep/canary jobs (no live
// request). The my-work BFS runs under a per-member withRLS context (so members
// are visibility-correct); scope writes are service-role (SELECT-only RLS), org-
// scoped by explicit org_id. No node text is read or logged here.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { qstash } from '@/lib/qstash/client'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import type { RLSContext } from '@/lib/supabase/rls-client'
import { getMyWork, type MyWorkResult } from './my-work'
import { ORG_SCOPE, personScope } from './scope-registry'
import { enqueueScopeSummary } from './scope-summary'

const STALE_DAYS = 7
const CANARY_DRIFT_THRESHOLD = 0.2 // Jaccard distance above which we alert.

interface MemberRow { id: string; display_name: string | null; email: string; department_id: string | null; role: string }

/** Collect the node ids in a member's 2-hop work graph from a my-work result. */
export function collectWorkNodeIds(work: MyWorkResult): string[] {
  const ids = new Set<string>()
  if (work.person) ids.add(work.person.id)
  for (const item of work.items) {
    ids.add(item.node.id)
    for (const b of item.blockers) {
      ids.add(b.node.id)
      for (const u of b.upstream) ids.add(u.node.id)
    }
  }
  return [...ids]
}

async function loadMember(orgId: string, memberId: string): Promise<MemberRow | null> {
  const { data } = await supabaseAdmin
    .from('org_members')
    .select('id, display_name, email, department_id, role')
    .eq('org_id', orgId)
    .eq('id', memberId)
    .maybeSingle()
  return (data as MemberRow) ?? null
}

function ctxFor(orgId: string, m: MemberRow): RLSContext {
  return {
    org_id: orgId,
    user_id: m.id,
    department_id: m.department_id ?? undefined,
    user_role: (m.role as RLSContext['user_role']) ?? 'member',
  }
}

async function ensureOrgScopeId(orgId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('kg_scopes')
    .upsert({ org_id: orgId, level: 'org', key: ORG_SCOPE.key, title: ORG_SCOPE.title, updated_at: new Date().toISOString() }, { onConflict: 'org_id,level,key' })
    .select('id')
    .single()
  return (data as { id: string } | null)?.id ?? null
}

/**
 * Materialize (rebuild) a member's person scope from the live my-work BFS. Returns
 * the member count, or null when the member / their person node can't be resolved.
 */
export async function materializePersonScope(
  orgId: string,
  memberId: string,
): Promise<{ memberCount: number } | null> {
  if (!HIERARCHY_SCOPES || !orgId || !memberId) return null
  try {
    const member = await loadMember(orgId, memberId)
    if (!member) return null

    const work = await getMyWork(ctxFor(orgId, member), { displayName: member.display_name, email: member.email })
    if (!work.person) return null // no person node → nothing to materialize yet

    const nodeIds = collectWorkNodeIds(work)
    const orgScopeId = await ensureOrgScopeId(orgId)

    // Upsert the person scope (bump stale_after; reactivate if previously stale).
    const staleAfter = new Date(Date.now() + STALE_DAYS * 86_400_000).toISOString()
    const { data: scope } = await supabaseAdmin
      .from('kg_scopes')
      .upsert({
        org_id: orgId, level: 'person', key: memberId,
        title: member.display_name || member.email, parent_scope_id: orgScopeId,
        status: 'active', stale_after: staleAfter, freshness: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id,level,key' })
      .select('id')
      .single()
    const scopeId = (scope as { id: string } | null)?.id
    if (!scopeId) return null

    // Replace memberships wholesale (person scopes must equal the live BFS).
    await supabaseAdmin.from('kg_scope_members').delete().eq('scope_id', scopeId)
    if (nodeIds.length > 0) {
      const rows = nodeIds.map((node_id) => ({ org_id: orgId, scope_id: scopeId, node_id, weight: 1 }))
      const { error } = await supabaseAdmin.from('kg_scope_members').upsert(rows, { onConflict: 'scope_id,node_id' })
      if (error) logger.warn({ memberId, err: error.message }, '[person-scope] member upsert failed')
    }

    enqueueScopeSummary(orgId) // person scope now dirty → summarized
    return { memberCount: nodeIds.length }
  } catch (err) {
    logger.warn({ orgId, memberId, err: err instanceof Error ? err.message : String(err) }, '[person-scope] materialize failed (non-fatal)')
    return null
  }
}

/**
 * Activation (login / sync-touch): bump the person scope's freshness window and
 * enqueue a (debounced) materialize. The UI never blocks on this — reads fall
 * back to the live my-work BFS while materialization runs in the background.
 */
export function activatePersonScope(orgId: string, memberId: string): void {
  enqueuePersonScope(orgId, memberId)
}

/** Daily sweep: mark past-stale person scopes `stale` and delete their derived rows. */
export async function sweepStalePersonScopes(orgId: string): Promise<{ swept: number }> {
  const now = new Date().toISOString()
  const { data: stale, error } = await supabaseAdmin
    .from('kg_scopes')
    .select('id')
    .eq('org_id', orgId)
    .eq('level', 'person')
    .eq('status', 'active')
    .lt('stale_after', now)
  if (error) {
    logger.warn({ orgId, err: error.message }, '[person-scope] sweep select failed')
    return { swept: 0 }
  }
  const ids = (stale ?? []).map((r) => (r as { id: string }).id)
  for (const scopeId of ids) {
    await supabaseAdmin.from('kg_scope_members').delete().eq('scope_id', scopeId)
    await supabaseAdmin.from('kg_scope_summaries').delete().eq('scope_id', scopeId)
    await supabaseAdmin.from('kg_scopes').update({ status: 'stale', updated_at: now }).eq('id', scopeId)
  }
  return { swept: ids.length }
}

function jaccardDistance(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : 1 - inter / union
}

/**
 * Nightly canary: for up to `n` random active person scopes, compare the
 * materialized member set against a fresh my-work BFS. Returns the max drift and
 * the scopes whose drift exceeds the threshold (logged as an alert) — the guard
 * that catches membership-maintenance bugs.
 */
export async function canaryCheck(orgId: string, n = 20): Promise<{ checked: number; maxDrift: number; drifted: number }> {
  const { data: scopes } = await supabaseAdmin
    .from('kg_scopes')
    .select('id, key')
    .eq('org_id', orgId)
    .eq('level', 'person')
    .eq('status', 'active')
    .limit(n)
  const rows = (scopes ?? []) as Array<{ id: string; key: string }>
  let maxDrift = 0
  let drifted = 0
  for (const s of rows) {
    const member = await loadMember(orgId, s.key)
    if (!member) continue
    const { data: memberRows } = await supabaseAdmin.from('kg_scope_members').select('node_id').eq('scope_id', s.id)
    const materialized = new Set((memberRows ?? []).map((r) => (r as { node_id: string }).node_id))
    const work = await getMyWork(ctxFor(orgId, member), { displayName: member.display_name, email: member.email })
    const live = new Set(collectWorkNodeIds(work))
    const drift = jaccardDistance(materialized, live)
    maxDrift = Math.max(maxDrift, drift)
    if (drift > CANARY_DRIFT_THRESHOLD) {
      drifted++
      logger.warn({ orgId, memberId: s.key, drift }, '[person-scope] canary drift over threshold — possible maintenance bug')
    }
  }
  return { checked: rows.length, maxDrift, drifted }
}

/** Distinct orgs with active person scopes (cron fan-out for sweep/canary). */
export async function listOrgsWithPersonScopes(limit = 200): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('kg_scopes')
    .select('org_id')
    .eq('level', 'person')
    .eq('status', 'active')
    .limit(5000)
  const seen = new Set<string>()
  for (const r of (data ?? []) as Array<{ org_id: string }>) {
    seen.add(r.org_id)
    if (seen.size >= limit) break
  }
  return [...seen]
}

function publish(body: Record<string, unknown>, dedup: string): void {
  if (!HIERARCHY_SCOPES) return
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return
  qstash.publishJSON({ url: `${appUrl}/api/worker/person-scope`, body, retries: 3, deduplicationId: dedup })
    .catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[person-scope] enqueue failed (non-fatal)'))
}

/** Enqueue a (debounced) materialize for one member. */
export function enqueuePersonScope(orgId: string, memberId: string): void {
  if (!orgId || !memberId) return
  publish({ org_id: orgId, member_id: memberId }, `org:person-scope:${orgId}:${memberId}`)
}

/** Enqueue an org's daily maintain (sweep + canary). */
export function enqueuePersonScopeMaintain(orgId: string): void {
  if (!orgId) return
  publish({ org_id: orgId, mode: 'maintain' }, `org:person-scope-maintain:${orgId}`)
}
