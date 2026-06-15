// ============================================================
// lib/langgraph/tools/get-scope-summary.ts — P6-9 (PLAN_C §2 / §6.3)
//
// The dedicated tool through which chat (and the briefing) read pre-computed scope
// summaries instead of N live graph queries. RLS-respecting: the read runs inside
// withRLS, so the kg_scopes / kg_scope_summaries policies enforce who may see a
// department or person summary — the tool never uses the service role. Gated by
// HIERARCHY_SCOPES; when off it reports "not enabled" so the agent falls back to
// its live tools (graph_query / vector_search).
// ============================================================

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { withRLS, type RLSContext } from '@/lib/supabase/rls-client'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import { logger } from '@/lib/logger'
import { registerTool } from './registry'

interface Highlights {
  overview?: string
  key_entities?: string[]
  active_blockers?: Array<{ from?: string; to?: string; owner?: string | null }>
  open_obligations?: string[]
  cross_scope_links?: Array<{ other_scope?: string }>
  rating?: number
}

/** Render a stored summary into a compact briefing block for the agent. */
function formatSummary(summary: string, h: Highlights): string {
  const lines = [summary.trim()]
  if (h.key_entities?.length) lines.push(`Key entities: ${h.key_entities.slice(0, 10).join(', ')}`)
  if (h.active_blockers?.length) {
    lines.push(
      'Active blockers: ' +
        h.active_blockers.slice(0, 8).map((b) => `${b.to ?? '?'} ← ${b.from ?? '?'}${b.owner ? ` (owner ${b.owner})` : ''}`).join('; '),
    )
  }
  if (h.open_obligations?.length) lines.push(`Open obligations: ${h.open_obligations.slice(0, 8).join('; ')}`)
  return lines.join('\n')
}

export const scopeSummaryTool = new DynamicStructuredTool({
  name: 'get_scope_summary',
  description:
    'Get the pre-computed intelligence summary for one scope of the org knowledge ' +
    'graph: a department, a team/vertical, a connected app, the whole organization, ' +
    'a topic community, or a person. Use for high-level "what is X working on / ' +
    'blocked by / responsible for" questions instead of many small graph lookups.',
  schema: z.object({
    level: z.enum(['org', 'vertical', 'department', 'app', 'community', 'person']),
    key: z
      .string()
      .describe("Scope key: 'root' for org; the vertical/app/community name; the department id or person (member) id"),
  }),
  func: async ({ level, key }, _runManager, config) => {
    if (!HIERARCHY_SCOPES) return 'Scope summaries are not enabled.'
    const cfg = (config as { configurable?: Record<string, unknown> } | undefined)?.configurable ?? {}
    const orgId = String(cfg.orgId ?? '')
    const userId = String(cfg.userId ?? '')
    if (!orgId || !userId) return 'Scope summary unavailable: missing org context.'

    const ctx: RLSContext = {
      org_id: orgId,
      user_id: userId,
      user_role: (cfg.role as RLSContext['user_role']) ?? 'member',
      department_id: (cfg.deptId as string | undefined) ?? undefined,
    }

    try {
      return await withRLS(ctx, async (supabase) => {
        // RLS on kg_scopes enforces readability (dept/person gating).
        const { data: scope } = await supabase
          .from('kg_scopes')
          .select('id, title')
          .eq('org_id', orgId).eq('level', level).eq('key', key)
          .maybeSingle()
        if (!scope) return `No ${level} scope "${key}" is available to you.`

        const { data: sum } = await supabase
          .from('kg_scope_summaries')
          .select('summary, highlights')
          .eq('org_id', orgId)
          .eq('scope_id', (scope as { id: string }).id)
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (!sum) return `No summary has been generated yet for ${level} "${key}".`

        const s = sum as { summary: string; highlights: Highlights }
        return `[${(scope as { title: string }).title}]\n${formatSummary(s.summary, s.highlights ?? {})}`
      })
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, '[get_scope_summary] read failed')
      return 'Scope summary lookup failed.'
    }
  },
})

registerTool(scopeSummaryTool)
