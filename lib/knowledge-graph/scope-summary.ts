// ============================================================
// lib/knowledge-graph/scope-summary.ts — P6-6 (PLAN_C §3.1 / §4)
//
// Generate one scope's GraphRAG-style summary: gather its salient (top-K by
// membership weight) member entities, the relations + active blockers among them,
// and its child scopes' summaries (strict bottom-up); skip if the input_hash is
// unchanged; else run the forked prompt through resolveModelClient and persist a
// new version into kg_scope_summaries.
//
// Visibility (§2/§4 guard): the summarizer only receives member nodes the scope's
// class can see — structural scopes (app/vertical/org/community) exclude
// confidential + restricted nodes; department scopes additionally require the node
// to belong to that department. Conservative: a summary never quotes content above
// its readability. (Person scopes are summarized in P6-7.)
//
// SERVICE-ROLE JUSTIFICATION: debounced QStash summary worker (no RLS session);
// reads kg_nodes/kg_edges/kg_scope_* and writes kg_scope_summaries (SELECT-only
// RLS, service-role writes). Org-scoped by explicit org_id. Node text reaches the
// LLM only via the injection-delimited prompt; nothing is logged.
// ============================================================

import 'server-only'
import { createHash } from 'crypto'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { qstash } from '@/lib/qstash/client'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import { resolveModelClient } from '@/lib/langgraph/llm-factory'
import {
  SCOPE_SUMMARY_SYSTEM,
  buildScopeSummaryPrompt,
  parseScopeHighlights,
  type ScopeSummaryContext,
  type ScopeHighlights,
} from './prompts/scope-summary'

export interface ScopeRow { id: string; level: string; key: string; title: string }

/** Top-K member entities fed to the summarizer, by level (PLAN_C §4). */
export const TOP_K: Record<string, number> = {
  community: 30, app: 50, vertical: 75, department: 75, org: 100, person: 40,
}

/** Bottom-up processing order: children before parents within one run. */
export const LEVEL_RANK: Record<string, number> = {
  community: 0, app: 1, vertical: 2, department: 2, org: 3, person: 1,
}

const EXCLUDED_VIS = new Set(['confidential', 'restricted'])

interface MemberNode {
  id: string
  label: string
  entity_type: string
  description: string | null
  visibility: string
  department_ids: string[]
}

function nodeVisibleToScope(scope: ScopeRow, n: MemberNode): boolean {
  // Person scopes were materialized under the member's own RLS (P6-7), so their
  // members are already visibility-correct for that person — don't re-exclude
  // their own confidential items from their personal summary.
  if (scope.level === 'person') return true
  if (EXCLUDED_VIS.has(n.visibility)) return false
  if (scope.level === 'department') return (n.department_ids ?? []).includes(scope.key)
  return true
}

interface GatheredInputs {
  context: ScopeSummaryContext
  inputHash: string
  memberCount: number
}

/** Gather + visibility-filter the summarizer inputs for a scope. */
export async function gatherScopeInputs(orgId: string, scope: ScopeRow): Promise<GatheredInputs | null> {
  const k = TOP_K[scope.level] ?? 50

  // 1. Top-K member node ids by membership weight.
  const { data: memberRows, error: mErr } = await supabaseAdmin
    .from('kg_scope_members')
    .select('node_id, weight')
    .eq('scope_id', scope.id)
    .order('weight', { ascending: false })
    .limit(k)
  if (mErr) {
    logger.warn({ scopeId: scope.id, err: mErr.message }, '[scope-summary] member load failed')
    return null
  }
  const memberIds = (memberRows ?? []).map((r) => (r as { node_id: string }).node_id)
  if (memberIds.length === 0) return null

  // 2. Node details (+ visibility filter).
  const { data: nodeRows, error: nErr } = await supabaseAdmin
    .from('kg_nodes')
    .select('id, label, entity_type, description, visibility, department_ids')
    .eq('org_id', orgId)
    .in('id', memberIds)
  if (nErr) {
    logger.warn({ scopeId: scope.id, err: nErr.message }, '[scope-summary] node load failed')
    return null
  }
  const visible = ((nodeRows ?? []) as MemberNode[]).filter((n) => nodeVisibleToScope(scope, n))
  if (visible.length === 0) return null
  const labelById = new Map(visible.map((n) => [n.id, n.label]))
  const visibleIds = [...labelById.keys()]

  // 3. Edges among the visible top-K (relations + blockers).
  const { data: edgeRows } = await supabaseAdmin
    .from('kg_edges')
    .select('source_node, target_node, relation')
    .eq('org_id', orgId)
    .in('source_node', visibleIds)
    .in('target_node', visibleIds)
  const relations: ScopeSummaryContext['relations'] = []
  const blockers: ScopeSummaryContext['blockers'] = []
  for (const e of (edgeRows ?? []) as Array<{ source_node: string; target_node: string; relation: string }>) {
    const from = labelById.get(e.source_node)
    const to = labelById.get(e.target_node)
    if (!from || !to) continue
    const rel = { from, to, relation: e.relation }
    relations.push(rel)
    if (e.relation === 'BLOCKS' || e.relation === 'BLOCKED_BY') blockers.push(rel)
  }

  // 4. Child scope summaries (latest version each) — strict bottom-up rollup.
  const { data: childScopes } = await supabaseAdmin
    .from('kg_scopes')
    .select('id, title')
    .eq('org_id', orgId)
    .eq('parent_scope_id', scope.id)
  const childSummaries: ScopeSummaryContext['childSummaries'] = []
  const childVersions: string[] = []
  for (const c of (childScopes ?? []) as Array<{ id: string; title: string }>) {
    const { data: sum } = await supabaseAdmin
      .from('kg_scope_summaries')
      .select('summary, version')
      .eq('org_id', orgId)
      .eq('scope_id', c.id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (sum && (sum as { summary?: string }).summary) {
      childSummaries.push({ title: c.title, overview: (sum as { summary: string }).summary })
      childVersions.push(`${c.id}:${(sum as { version: number }).version}`)
    }
  }

  // 5. input_hash — member set + edge set + child summary versions (sorted/stable).
  const inputHash = createHash('sha256')
    .update(JSON.stringify({
      m: visibleIds.slice().sort(),
      e: relations.map((r) => `${r.from}|${r.relation}|${r.to}`).sort(),
      c: childVersions.slice().sort(),
    }))
    .digest('hex')

  return {
    memberCount: visible.length,
    inputHash,
    context: {
      level: scope.level,
      title: scope.title,
      members: visible.map((n) => ({ label: n.label, entity_type: n.entity_type, description: n.description })),
      relations,
      blockers,
      childSummaries,
    },
  }
}

async function latestSummaryMeta(orgId: string, scopeId: string): Promise<{ version: number; inputHash: string } | null> {
  const { data } = await supabaseAdmin
    .from('kg_scope_summaries')
    .select('version, input_hash')
    .eq('org_id', orgId)
    .eq('scope_id', scopeId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return { version: (data as { version: number }).version, inputHash: (data as { input_hash: string }).input_hash }
}

function tierForLevel(level: string): 'simple' | 'medium' | 'complex' {
  return level === 'org' || level === 'vertical' ? 'complex' : 'medium'
}

export type SummarizeResult = 'generated' | 'unchanged' | 'empty' | 'error'

/**
 * Summarize one scope. Skips (returns 'unchanged') when the input_hash matches the
 * latest stored summary; otherwise generates a new version. Never throws.
 */
export async function summarizeScope(orgId: string, scope: ScopeRow): Promise<SummarizeResult> {
  try {
    const inputs = await gatherScopeInputs(orgId, scope)
    if (!inputs) return 'empty'

    const latest = await latestSummaryMeta(orgId, scope.id)
    if (latest && latest.inputHash === inputs.inputHash) return 'unchanged'

    const llm = await resolveModelClient(tierForLevel(scope.level), orgId, 0)
    const res = await llm.invoke([
      new SystemMessage(SCOPE_SUMMARY_SYSTEM),
      new HumanMessage(buildScopeSummaryPrompt(inputs.context)),
    ])
    const text = typeof res.content === 'string'
      ? res.content
      : Array.isArray(res.content)
        ? (res.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        : ''
    const highlights: ScopeHighlights | null = parseScopeHighlights(text)
    if (!highlights) {
      logger.warn({ scopeId: scope.id }, '[scope-summary] model returned unparseable JSON — skipping')
      return 'error'
    }

    const version = (latest?.version ?? 0) + 1
    const { error } = await supabaseAdmin.from('kg_scope_summaries').insert({
      org_id: orgId,
      scope_id: scope.id,
      version,
      summary: highlights.overview,
      highlights,
      input_hash: inputs.inputHash,
      model: tierForLevel(scope.level),
    })
    if (error) {
      logger.warn({ scopeId: scope.id, err: error.message }, '[scope-summary] insert failed')
      return 'error'
    }
    // Stamp freshness on the scope.
    await supabaseAdmin.from('kg_scopes').update({ freshness: new Date().toISOString() }).eq('id', scope.id).eq('org_id', orgId)
    return 'generated'
  } catch (err) {
    logger.warn(
      { scopeId: scope.id, err: err instanceof Error ? err.message : String(err) },
      '[scope-summary] summarize failed (non-fatal)',
    )
    return 'error'
  }
}

/**
 * Scopes that need a refresh: no summary yet, or the scope was touched
 * (updated_at) after its latest summary. Ordered bottom-up (children first) so a
 * parent's summary in the same run sees fresh child summaries.
 */
export async function selectDirtyScopes(orgId: string, limit = 200): Promise<ScopeRow[]> {
  const { data: scopes, error } = await supabaseAdmin
    .from('kg_scopes')
    .select('id, level, key, title, updated_at')
    .eq('org_id', orgId)
    .eq('status', 'active')
  if (error || !scopes) {
    if (error) logger.warn({ orgId, err: error.message }, '[scope-summary] scope load failed')
    return []
  }
  const dirty: Array<ScopeRow & { rank: number }> = []
  for (const s of scopes as Array<ScopeRow & { updated_at: string }>) {
    const latest = await supabaseAdmin
      .from('kg_scope_summaries')
      .select('created_at')
      .eq('org_id', orgId)
      .eq('scope_id', s.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const summaryAt = (latest.data as { created_at?: string } | null)?.created_at
    if (!summaryAt || new Date(s.updated_at).getTime() > new Date(summaryAt).getTime()) {
      dirty.push({ id: s.id, level: s.level, key: s.key, title: s.title, rank: LEVEL_RANK[s.level] ?? 1 })
    }
  }
  dirty.sort((a, b) => a.rank - b.rank)
  return dirty.slice(0, limit).map(({ id, level, key, title }) => ({ id, level, key, title }))
}

/** Read the latest stored summary for a scope (service-role; P6-9 gates the read path). */
export async function loadLatestScopeSummary(
  orgId: string, level: string, key: string,
): Promise<{ summary: string; highlights: ScopeHighlights; version: number } | null> {
  const { data: scope } = await supabaseAdmin
    .from('kg_scopes')
    .select('id')
    .eq('org_id', orgId).eq('level', level).eq('key', key)
    .maybeSingle()
  if (!scope) return null
  const { data } = await supabaseAdmin
    .from('kg_scope_summaries')
    .select('summary, highlights, version')
    .eq('org_id', orgId)
    .eq('scope_id', (scope as { id: string }).id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const d = data as { summary: string; highlights: ScopeHighlights; version: number }
  return { summary: d.summary, highlights: d.highlights, version: d.version }
}

/**
 * Enqueue a debounced summary refresh for an org. Deduped per org so the many
 * membership changes in one sync coalesce into one refresh (the §3.1 15-min
 * window). No-op when the flag is off or the app url is unset; never throws.
 */
export function enqueueScopeSummary(orgId: string): void {
  if (!HIERARCHY_SCOPES || !orgId) return
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return
  qstash.publishJSON({
    url: `${appUrl}/api/worker/scope-summary`,
    body: { org_id: orgId },
    retries: 3,
    deduplicationId: `org:scope-summary:${orgId}`,
  }).catch((err) => logger.warn(
    { orgId, err: err instanceof Error ? err.message : String(err) },
    '[scope-summary] enqueue failed (non-fatal)',
  ))
}
