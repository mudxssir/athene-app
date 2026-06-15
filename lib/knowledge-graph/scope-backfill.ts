// ============================================================
// lib/knowledge-graph/scope-backfill.ts — P6-4 (PLAN_C §3.1 / §3.4)
//
// Builds app/vertical/department scope memberships from the EXISTING flat graph
// for an org — the one-time backfill when scopes are first enabled, and the
// recovery answer behind the rebuild escape hatch (§3.4). Paged by node-id cursor
// so the worker can re-enqueue the next page (Vercel-timeout safe) and is
// resumable; idempotent (memberships upsert on their PK → hash-stable across
// reruns, the §6 acceptance criterion).
//
// A node's provider(s) come from its source_documents → documents.source_type
// (a node can be mentioned across connectors, so it can join multiple app scopes).
//
// SERVICE-ROLE JUSTIFICATION: runs in the QStash scope-backfill worker / admin
// rebuild job (no RLS session). kg_scopes/kg_scope_members are SELECT-only RLS;
// writes are service-role (like kg_node_aliases backfill). Org-scoped by explicit
// org_id; reads touch only this org. No chunk/content text read or logged.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { qstash } from '@/lib/qstash/client'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import { applyScopeMemberships, type ScopeMembershipEntry } from './scope-maintenance'

/** Nodes processed per backfill page (each page is one worker invocation slice). */
export const NODE_PAGE = 200

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

interface BackfillNodeRow {
  id: string
  department_ids: string[] | null
  source_documents: string[] | null
}

/**
 * Backfill one page of nodes (id > cursor, ascending). Resolves each node's
 * provider(s) from its source documents, then upserts app/vertical/dept
 * memberships via the shared core. Returns the page size + the next cursor
 * (null when the graph is exhausted).
 */
export async function backfillScopeMembershipsPage(
  orgId: string,
  cursor: string = '',
  limit: number = NODE_PAGE,
): Promise<{ processed: number; nextCursor: string | null }> {
  const { data: nodes, error } = await supabaseAdmin
    .from('kg_nodes')
    .select('id, department_ids, source_documents')
    .eq('org_id', orgId)
    .gt('id', cursor || ZERO_UUID)
    .order('id', { ascending: true })
    .limit(limit)
  if (error) {
    logger.warn({ orgId, err: error.message }, '[scope-backfill] node page read failed')
    return { processed: 0, nextCursor: null }
  }
  const rows = (nodes ?? []) as BackfillNodeRow[]
  if (rows.length === 0) return { processed: 0, nextCursor: null }

  // Resolve provider per source document for this page in one query.
  const docIds = [...new Set(rows.flatMap((n) => n.source_documents ?? []).filter(Boolean))]
  const providerByDoc = new Map<string, string>()
  if (docIds.length > 0) {
    const { data: docs, error: docErr } = await supabaseAdmin
      .from('documents')
      .select('id, source_type')
      .eq('org_id', orgId)
      .in('id', docIds)
    if (docErr) {
      logger.warn({ orgId, err: docErr.message }, '[scope-backfill] document provider read failed')
    } else {
      for (const d of (docs ?? []) as Array<{ id: string; source_type: string }>) {
        if (d.source_type) providerByDoc.set(d.id, d.source_type)
      }
    }
  }

  // One entry per (node, distinct provider).
  const entries: ScopeMembershipEntry[] = []
  for (const n of rows) {
    const providers = [
      ...new Set((n.source_documents ?? []).map((d) => providerByDoc.get(d)).filter((p): p is string => !!p)),
    ]
    for (const provider of providers) {
      entries.push({ nodeId: n.id, provider, departmentIds: n.department_ids ?? [] })
    }
  }
  if (entries.length > 0) await applyScopeMemberships(orgId, entries)

  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null
  return { processed: rows.length, nextCursor }
}

/**
 * Teardown for the rebuild escape hatch (§3.4): drop all scope memberships for the
 * org. Structural scope rows (app/vertical/dept/org) are left intact — they are
 * stable and re-asserted by the backfill — so the rebuild is "memberships from
 * scratch" without losing the skeleton or its summaries' lineage.
 */
export async function clearScopeMemberships(orgId: string): Promise<void> {
  const { error } = await supabaseAdmin.from('kg_scope_members').delete().eq('org_id', orgId)
  if (error) {
    logger.warn({ orgId, err: error.message }, '[scope-backfill] clear memberships failed')
  }
}

/**
 * Enqueue (or continue) a scope-backfill for an org. Deduped per (org, cursor) so
 * a page is never double-processed. No-op when the flag is off or the app url is
 * unset. Fire-and-forget; never throws.
 */
export function enqueueScopeBackfill(orgId: string, cursor: string = ''): void {
  if (!HIERARCHY_SCOPES || !orgId) return
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    logger.warn({ orgId }, '[scope-backfill] NEXT_PUBLIC_APP_URL not set — cannot enqueue')
    return
  }
  qstash.publishJSON({
    url: `${appUrl}/api/worker/scope-backfill`,
    body: { org_id: orgId, cursor },
    retries: 3,
    deduplicationId: `org:scope-backfill:${orgId}:${cursor || 'start'}`,
  }).catch((err) => logger.warn(
    { orgId, err: err instanceof Error ? err.message : String(err) },
    '[scope-backfill] enqueue failed (non-fatal)',
  ))
}
