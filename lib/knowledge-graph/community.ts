// ============================================================
// knowledge-graph/community.ts — Community detection (ATH-60)
//
// After all documents are processed, run Louvain modularity
// optimisation (REFOCUS §5.5) to assign community IDs to kg_nodes.
// Unlike the previous connected-components pass, Louvain splits
// large connected blobs into densely-linked clusters, so briefing
// and graph views surface meaningful topic groups.
//
// Edge confidence is used as the edge weight; parallel edges
// accumulate. Community IDs are stable strings (lowest node ID in
// the cluster) so reruns produce consistent IDs for stable clusters.
// ============================================================

// SERVICE-ROLE JUSTIFICATION: org-wide batch job run post-indexing; must see
// the full org graph to compute communities. Writes only kg_nodes.community.
import { supabaseAdmin } from '@/lib/supabase/server'
import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { logger } from '@/lib/logger'

const PAGE_SIZE = 5_000

// ---- Pure Louvain partition (P6-5) --------------------------
//
// Extracted so the per-app community-scope builder (community-scopes.ts) and the
// org-wide detectCommunities both run the same modularity optimisation. Pure (no
// DB) → unit-testable. This is the interim engine; the Leiden sidecar lane
// (graspologic, hierarchical partitions) replaces it behind this same shape once
// the parity test passes (playbook A-vs-B verdict).

export interface PartitionEdge { source: string; target: string; weight?: number }
export interface PartitionCommunity { communityId: string; memberIds: string[] }

/**
 * Louvain partition over an undirected weighted graph. Parallel edges accumulate
 * weight; self-loops and edges to unknown nodes are skipped. Each community's id
 * is its lowest member node id (lexicographic) so reruns are stable. Isolated
 * nodes each form their own (singleton) community.
 */
export function louvainPartition(nodeIds: string[], edges: PartitionEdge[]): PartitionCommunity[] {
  if (nodeIds.length === 0) return []
  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false })
  for (const id of nodeIds) if (!graph.hasNode(id)) graph.addNode(id)
  for (const e of edges) {
    if (e.source === e.target) continue
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue
    const w = e.weight ?? 1
    if (graph.hasEdge(e.source, e.target)) {
      graph.updateEdgeAttribute(e.source, e.target, 'weight', (cur) => (cur ?? 0) + w)
    } else {
      graph.addEdge(e.source, e.target, { weight: w })
    }
  }
  const assignments = louvain(graph, { getEdgeWeight: 'weight' })
  const byCluster = new Map<number | string, string[]>()
  for (const [nodeId, cluster] of Object.entries(assignments)) {
    if (!byCluster.has(cluster)) byCluster.set(cluster, [])
    byCluster.get(cluster)!.push(nodeId)
  }
  return [...byCluster.values()].map((memberIds) => ({
    communityId: memberIds.reduce((min, id) => (id < min ? id : min)),
    memberIds,
  }))
}

// ---- Paginated loads ----------------------------------------

async function paginateNodes(orgId: string): Promise<{ id: string }[]> {
  const results: { id: string }[] = []
  let offset = 0
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('kg_nodes').select('id').eq('org_id', orgId)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`[community] Failed to load nodes: ${error.message}`)
    if (!data || data.length === 0) break
    results.push(...data)
    if (data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return results
}

async function paginateEdges(
  orgId: string,
): Promise<{ source_node: string; target_node: string; confidence: number | null }[]> {
  const results: { source_node: string; target_node: string; confidence: number | null }[] = []
  let offset = 0
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('kg_edges').select('source_node, target_node, confidence').eq('org_id', orgId)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`[community] Failed to load edges: ${error.message}`)
    if (!data || data.length === 0) break
    results.push(...data)
    if (data.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return results
}

// ---- Main function ------------------------------------------

/**
 * Assigns community IDs to all kg_nodes for the given org using
 * Louvain modularity optimisation over the weighted kg_edges graph.
 * Each node gets community = lowest member node ID of its cluster.
 */
export async function detectCommunities(orgId: string): Promise<void> {
  // 1. Load all node IDs (paginated — unbounded load OOMs on large orgs)
  const nodes = await paginateNodes(orgId)
  if (nodes.length === 0) return

  // 2. Load all edges (paginated)
  const edges = await paginateEdges(orgId)
  logger.info(
    { orgId, nodeCount: nodes.length, edgeCount: edges.length },
    '[community] Loaded graph — starting Louvain',
  )

  // 3. Build an undirected weighted graph
  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false })
  for (const row of nodes) {
    graph.addNode(row.id)
  }
  for (const edge of edges) {
    const { source_node: a, target_node: b } = edge
    if (a === b) continue
    if (!graph.hasNode(a) || !graph.hasNode(b)) continue
    const weight = edge.confidence ?? 1
    if (graph.hasEdge(a, b)) {
      // Parallel edges (same pair, different relations) reinforce the tie
      graph.updateEdgeAttribute(a, b, 'weight', (w) => (w ?? 0) + weight)
    } else {
      graph.addEdge(a, b, { weight })
    }
  }

  // 4. Run Louvain — isolated nodes each get their own community
  const louvainAssignments = louvain(graph, { getEdgeWeight: 'weight' })

  // 5. Stable community IDs: lowest node ID (lexicographic) per cluster
  const byLouvainCommunity = new Map<number | string, string[]>()
  for (const [nodeId, communityIdx] of Object.entries(louvainAssignments)) {
    if (!byLouvainCommunity.has(communityIdx)) byLouvainCommunity.set(communityIdx, [])
    byLouvainCommunity.get(communityIdx)!.push(nodeId)
  }

  const byCommunity = new Map<string, string[]>()
  for (const memberIds of byLouvainCommunity.values()) {
    const communityId = memberIds.reduce((min, id) => (id < min ? id : min))
    byCommunity.set(communityId, memberIds)
  }

  logger.info(
    { orgId, communities: byCommunity.size },
    '[community] Louvain complete — persisting assignments',
  )

  // 6. Update kg_nodes.community in batches per community
  const batchSize = 100
  for (const [communityId, memberIds] of byCommunity) {
    for (let i = 0; i < memberIds.length; i += batchSize) {
      const batch = memberIds.slice(i, i + batchSize)
      const { error } = await supabaseAdmin
        .from('kg_nodes')
        .update({ community: communityId })
        .eq('org_id', orgId)
        .in('id', batch)

      if (error) {
        logger.error({ orgId, communityId, err: error.message }, '[community] Update failed')
      }
    }
  }
}
