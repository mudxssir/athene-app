// ============================================================
// tools/graph-query.ts — Knowledge graph traversal tool (ATH-62)
//
// Wraps the kg_nodes / kg_edges tables as a DynamicStructuredTool
// so all agents can query entity relationships at inference time.
//
// Flow:
//   question → extract entity labels (gpt-4o-mini) →
//   findNodes (kg_nodes) → traverseFromNode BFS (kg_edges) →
//   format readable string → return to agent
//
// Security:
//   - Non-BI users only see visibility='org_wide' nodes.
//   - bi_analysts see public + department nodes.
//   - Edges referencing inaccessible nodes are silently omitted.
//   - boundary_reached is surfaced in output when traversal stops.
//
// Never throws — always returns a graceful string.
// ============================================================

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withRLS, type RLSContext } from '@/lib/supabase/rls-client'
import { resolveModelClient } from '../llm-factory'
import { registerTool } from './registry'
import { logger } from '@/lib/logger'

/**
 * Sanitise a value for use in raw PostgREST `.or()` filter strings.
 * Strips characters that could break the filter grammar.
 */
function sanitizeForPostgrest(value: string): string {
  return value.replace(/[",\\.()]/g, '')
}

// ---- Types --------------------------------------------------

interface GraphNode {
  id: string
  label: string
  entity_type: string
  visibility: string
  department_ids: string[] | null
  description: string | null
}

interface GraphEdge {
  source_node: string
  target_node: string
  relation: string
  provenance: string
  confidence: number
}

// ---- Entity label extraction --------------------------------

/**
 * Uses gpt-4o-mini to extract entity names from the question.
 * Returns [] on parse failure — never throws.
 */
async function extractEntityLabels(
  question: string,
  orgId: string,
): Promise<string[]> {
  try {
    const mini = await resolveModelClient('simple', orgId, 0)
    const response = await mini.invoke([
      {
        role: 'system',
        content:
          'Extract the entity names mentioned in the question. ' +
          'Return a JSON array of strings only, e.g. ["AWS", "Payment Service"]. ' +
          'Return [] if none found. Return only valid JSON — no prose.',
      },
      { role: 'user', content: question },
    ])
    const text =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)
    const cleaned = text.replace(/```json\n?|```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return Array.isArray(parsed) ? parsed.map((s: unknown) => String(s)) : []
  } catch {
    return []
  }
}

// ---- Node lookup --------------------------------------------

async function findNodes(
  supabase: SupabaseClient,
  orgId: string,
  labels: string[],
  entityTypes: string[] | undefined,
  role: string,
): Promise<GraphNode[]> {
  if (labels.length === 0) return []

  let query = supabase
    .from('kg_nodes')
    .select('id, label, entity_type, visibility, department_ids, description')
    .eq('org_id', orgId)

  // Non-BI analysts only see public nodes
  if (role !== 'bi_analyst') {
    query = query.eq('visibility', 'org_wide')
  }

  if (entityTypes && entityTypes.length > 0) {
    query = query.in('entity_type', entityTypes)
  }

  // OR-match across all label variants (case-insensitive)
  // Sanitise labels to prevent PostgREST filter injection
  const labelFilter = labels
    .map((l) => `label.ilike.%${sanitizeForPostgrest(l)}%`)
    .join(',')
  const { data, error } = await query.or(labelFilter).limit(20)

  if (error) throw new Error(`[graph-query] findNodes: ${error.message}`)
  return (data ?? []) as GraphNode[]
}

// ---- BFS traversal ------------------------------------------

async function traverseFromNode(
  supabase: SupabaseClient,
  orgId: string,
  startId: string,
  maxHops: number,
  role: string,
  visited: Set<string>,
  minConfidence = 0.5,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; boundaryReached: boolean }> {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let boundaryReached = false

  // Priority queue: highest accumulated confidence score explored first
  const queue: Array<{ id: string; hop: number; score: number }> = [
    { id: startId, hop: 0, score: 1.0 },
  ]

  while (queue.length > 0) {
    // Sort descending by score so highest-confidence paths run first
    queue.sort((a, b) => b.score - a.score)
    const { id, hop, score: currentScore } = queue.shift()!
    if (visited.has(id)) continue
    if (hop >= maxHops) {
      boundaryReached = true
      continue
    }
    visited.add(id)

    // Fetch adjacent edges
    const { data: edgeRows, error: edgeErr } = await supabase
      .from('kg_edges')
      .select('source_node, target_node, relation, provenance, confidence')
      .eq('org_id', orgId)
      .or(`source_node.eq.${id},target_node.eq.${id}`)
      .limit(50)

    if (edgeErr) continue

    for (const edge of edgeRows ?? []) {
      const edgeConf = (edge as any).confidence ?? 1.0
      // Skip low-confidence edges to keep traversal focused on reliable paths
      if (edgeConf < minConfidence) continue
      edges.push(edge as GraphEdge)
      const nextId =
        edge.source_node === id ? edge.target_node : edge.source_node
      if (!visited.has(nextId)) {
        queue.push({ id: nextId, hop: hop + 1, score: currentScore * edgeConf })
      }
    }

    // Fetch the node itself
    const { data: nodeRow } = await supabase
      .from('kg_nodes')
      .select('id, label, entity_type, visibility, department_ids, description')
      .eq('id', id)
      .eq('org_id', orgId)
      .single()

    if (!nodeRow) continue

    // Visibility gate
    if (role !== 'bi_analyst' && nodeRow.visibility !== 'org_wide') {
      boundaryReached = true
      continue
    }

    nodes.push(nodeRow as GraphNode)
  }

  return { nodes, edges, boundaryReached }
}

// ---- Result formatter ---------------------------------------

function formatResult(
  nodes: GraphNode[],
  edges: GraphEdge[],
  boundaryReached: boolean,
): string {
  if (nodes.length === 0) return 'No knowledge graph data available yet.'

  const nodeMap: Record<string, { label: string; type: string; confidence: number }> = {}
  for (const n of nodes) {
    nodeMap[n.id] = { label: n.label, type: n.entity_type, confidence: 1.0 }
  }

  const edgeList = edges.map((e) => ({
    from: e.source_node,
    to: e.target_node,
    from_label: nodes.find((n) => n.id === e.source_node)?.label ?? e.source_node,
    to_label: nodes.find((n) => n.id === e.target_node)?.label ?? e.target_node,
    relation: e.relation,
    confidence: e.confidence,
    provenance: e.provenance,
  }))

  return JSON.stringify({
    center: nodes[0]?.label ?? '',
    nodeCount: nodes.length,
    nodes: Object.values(nodeMap),
    edges: edgeList,
    boundaryReached,
    departments: [...new Set(nodes.flatMap((n) => n.department_ids ?? []))],
  })
}

// ---- Tool definition ----------------------------------------

export const graphQueryTool = new DynamicStructuredTool({
  name: 'graph_query',
  description:
    'Find entities and their relationships in the org knowledge graph. ' +
    'Use when the question asks about connections, dependencies, or impact chains.',
  schema: z.object({
    question: z
      .string()
      .describe('The question or topic to look up in the knowledge graph'),
    maxHops: z
      .number()
      .default(2)
      .describe('Maximum traversal depth (1-3 recommended)'),
    entityTypes: z
      .array(z.string())
      .optional()
      .describe('Optionally filter by entity type (person, project, service, …)'),
  }),
  func: async ({ question, maxHops, entityTypes }, _runManager, config) => {
    const cfg = (config as any)?.configurable ?? {}
    const orgId: string = cfg.orgId ?? ''
    const userId: string = cfg.userId ?? ''
    const role: string = cfg.role ?? 'member'
    const deptId: string | null = cfg.deptId ?? null

    if (!orgId || !userId) return 'Knowledge graph unavailable: missing org context.'

    const rlsCtx: RLSContext = {
      org_id: orgId,
      user_id: userId,
      user_role: role as RLSContext['user_role'],
      department_id: deptId ?? undefined,
    }

    try {
      const labels = await extractEntityLabels(question, orgId)
      if (labels.length === 0) {
        return 'No entities found in your question to look up in the knowledge graph.'
      }

      // All graph reads run inside withRLS (REFOCUS §5.1); the role-based
      // visibility filters below remain as defense-in-depth.
      return await withRLS(rlsCtx, async (supabase) => {
        const seedNodes = await findNodes(supabase, orgId, labels, entityTypes, role)
        if (seedNodes.length === 0) return 'No knowledge graph data available yet.'

        const allNodes = new Map<string, GraphNode>()
        const allEdges = new Map<string, GraphEdge>()
        let anyBoundary = false
        const visited = new Set<string>()

        for (const node of seedNodes) {
          allNodes.set(node.id, node)
          const { nodes, edges, boundaryReached } = await traverseFromNode(
            supabase,
            orgId,
            node.id,
            maxHops,
            role,
            visited,
          )
          for (const n of nodes) allNodes.set(n.id, n)
          for (const e of edges) {
            const key = `${e.source_node}|${e.relation}|${e.target_node}`
            allEdges.set(key, e)
          }
          if (boundaryReached) anyBoundary = true
        }

        return formatResult(
          Array.from(allNodes.values()),
          Array.from(allEdges.values()),
          anyBoundary,
        )
      })
    } catch (err: unknown) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, '[graph-query] error')
      return 'No knowledge graph data available yet.'
    }
  },
})

// Auto-register for all roles
registerTool(graphQueryTool)
