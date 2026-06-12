// ============================================================
// query.ts — kg_nodes / kg_edges read layer (ATH-61)
//
// All reads run inside withRLS() so org isolation is enforced.
// ============================================================

import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
import { fetchOrgPinnedModel } from "@/lib/ai/embedding-factory";
import { PIPELINE_SHAPE_ROUTING } from "@/lib/config/feature-flags";
import type { KGNode } from "./types";
import { resolveEntity, type EntityCandidate, type ResolveEntityOptions } from "./entity-resolver";

/**
 * Sanitise a value for use in raw PostgREST `.or()` filter strings.
 * Strips characters that could break the filter grammar (quotes,
 * commas, parens, dots) and prevents filter-injection attacks.
 */
function sanitizeForPostgrest(value: string): string {
  return value.replace(/[",\\.()]/g, "");
}

export type GraphNode = KGNode & { 
  id: string; 
  community?: string; 
  updated_at?: string; 
};

export type GraphEdge = {
  id: string;
  org_id: string;
  source_node: string;
  target_node: string;
  relation: string;
  provenance: string;
  confidence: number;
  source_document?: string | null;
  department_id?: string | null;
  visibility: string;
  metadata?: Record<string, unknown>;
  updated_at?: string;
};

export type QueryResult = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  boundary_reached: boolean;
  truncated?: boolean;
};

/**
 * Find nodes by label or description (case-insensitive).
 * Uses PostgREST ilike for prefix/infix matches. While this can utilize
 * the gin_trgm index, it is not a true similarity() search.
 */
export async function searchNodes(
  ctx: RLSContext,
  query: string,
  limit = 20
): Promise<QueryResult> {
  return withRLS(ctx, async (supabase) => {
    if (!query.trim()) return { nodes: [], edges: [], boundary_reached: false };

    const { data, error } = await supabase
      .from("kg_nodes")
      .select("*")
      .eq("org_id", ctx.org_id)
      .or(`label.ilike.%${sanitizeForPostgrest(query)}%,description.ilike.%${sanitizeForPostgrest(query)}%`)
      .limit(limit);

    if (error) throw new Error(`searchNodes failed: ${error.message}`);
    const nodes = (data ?? []) as GraphNode[];
    return {
      nodes,
      edges: [],
      boundary_reached: false,
      truncated: nodes.length >= limit,
    };
  });
}

/**
 * Filtered search for nodes.
 * Uses PostgREST ilike for prefix/infix matches on the label column.
 * Optimized by the gin_trgm index, but performs string matching rather than similarity search.
 */
export async function findNodes(
  ctx: RLSContext,
  filters: {
    labels?: string[];
    entityTypes?: string[];
    query?: string;
  },
  limit = 50
): Promise<QueryResult> {
  return withRLS(ctx, async (supabase) => {
    let q = supabase.from("kg_nodes").select("*").eq("org_id", ctx.org_id);

    if (filters.query?.trim()) {
      q = q.ilike("label", `%${filters.query.trim()}%`);
    }
    if (filters.labels && filters.labels.length > 0) {
      q = q.in("label", filters.labels);
    }
    if (filters.entityTypes && filters.entityTypes.length > 0) {
      q = q.in("entity_type", filters.entityTypes);
    }

    const { data, error } = await q.limit(limit);

    if (error) throw new Error(`findNodes failed: ${error.message}`);
    const nodes = (data ?? []) as GraphNode[];
    return {
      nodes,
      edges: [],
      boundary_reached: false,
      truncated: nodes.length >= limit,
    };
  });
}

/**
 * Multi-hop BFS traversal starting from a specific node.
 * Returns the discovered subgraph (nodes and edges).
 */
export async function traverseFromNode(
  ctx: RLSContext,
  nodeId: string,
  options: {
    maxHops?: number;
    relationFilter?: string[];
  } = {}
): Promise<QueryResult> {
  const { maxHops = 3, relationFilter } = options;

  return withRLS(ctx, async (supabase) => {
    const discoveredNodes = new Map<string, GraphNode>();
    const discoveredEdges = new Map<string, GraphEdge>();
    
    const { data: startNode, error: startErr } = await supabase
      .from("kg_nodes")
      .select("*")
      .eq("id", nodeId)
      .eq("org_id", ctx.org_id)
      .maybeSingle();

    if (startErr) throw new Error(`Traversal start failed: ${startErr.message}`);
    if (!startNode) return { nodes: [], edges: [], boundary_reached: false };

    discoveredNodes.set(nodeId, startNode as GraphNode);

    let currentHopNodes = [nodeId];
    let visited = new Set<string>([nodeId]);
    let boundary_reached = false;

    for (let hop = 0; hop < maxHops; hop++) {
      if (currentHopNodes.length === 0) break;

      // Use chained PostgREST .in() with properly quoted IDs
      // to prevent injection via crafted UUIDs
      let query = supabase
        .from("kg_edges")
        .select("*, source:kg_nodes!source_node(*), target:kg_nodes!target_node(*)")
        .eq("org_id", ctx.org_id)
        .or(
          `source_node.in.(${currentHopNodes.map(id => `"${sanitizeForPostgrest(id)}"`).join(",")}),` +
          `target_node.in.(${currentHopNodes.map(id => `"${sanitizeForPostgrest(id)}"`).join(",")})`
        );

      if (relationFilter && relationFilter.length > 0) {
        query = query.in("relation", relationFilter);
      }

      const { data: edges, error: edgeErr } = await query;
      if (edgeErr) throw new Error(`Traversal hop ${hop} failed: ${edgeErr.message}`);

      const nextHopNodes: string[] = [];

      for (const e of edges ?? []) {
        const { source, target, ...edgeData } = e;
        discoveredEdges.set(e.id, edgeData as GraphEdge);

        const neighbors = [
          { id: e.source_node, data: source },
          { id: e.target_node, data: target },
        ];

        for (const n of neighbors) {
          if (n.data) {
            if (!discoveredNodes.has(n.id)) {
              discoveredNodes.set(n.id, n.data as GraphNode);
              if (!visited.has(n.id)) {
                nextHopNodes.push(n.id);
                visited.add(n.id);
              }
            }
          } else {
            // Edge exists but node is missing (likely RLS-blocked)
            boundary_reached = true;
          }
        }
      }

      currentHopNodes = nextHopNodes;
      if (hop === maxHops - 1 && currentHopNodes.length > 0) {
        boundary_reached = true;
      }
    }

    return {
      nodes: Array.from(discoveredNodes.values()),
      edges: Array.from(discoveredEdges.values()),
      boundary_reached,
    };
  });
}

/**
 * Get a single node by its UUID.
 */
export async function getNodeById(
  ctx: RLSContext,
  id: string
): Promise<QueryResult> {
  return withRLS(ctx, async (supabase) => {
    const { data, error } = await supabase
      .from("kg_nodes")
      .select("*")
      .eq("org_id", ctx.org_id)
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(`getNodeById failed: ${error.message}`);
    return {
      nodes: data ? [data as GraphNode] : [],
      edges: [],
      boundary_reached: false,
    };
  });
}

/**
 * Get a single node by its label and entity type.
 */
export async function getNodeByLabel(
  ctx: RLSContext,
  label: string,
  entityType: string
): Promise<QueryResult> {
  return withRLS(ctx, async (supabase) => {
    const { data, error } = await supabase
      .from("kg_nodes")
      .select("*")
      .eq("org_id", ctx.org_id)
      .eq("label", label)
      .eq("entity_type", entityType)
      .maybeSingle();

    if (error) throw new Error(`getNodeByLabel failed: ${error.message}`);
    return {
      nodes: data ? [data as GraphNode] : [],
      edges: [],
      boundary_reached: false,
    };
  });
}

/**
 * Get all neighbors (1-hop) for a node. Returns both outbound
 * and inbound edges with the corresponding neighbor node.
 */
export async function getNeighbors(
  ctx: RLSContext,
  nodeId: string
): Promise<QueryResult> {
  return withRLS(ctx, async (supabase) => {
    const { data: edgesWithNodes, error: edgeErr } = await supabase
      .from("kg_edges")
      .select("*, source:kg_nodes!source_node(*), target:kg_nodes!target_node(*)")
      .eq("org_id", ctx.org_id)
      .or(`source_node.eq.${sanitizeForPostgrest(nodeId)},target_node.eq.${sanitizeForPostgrest(nodeId)}`);

    if (edgeErr) throw new Error(`getNeighbors fetch failed: ${edgeErr.message}`);

    const discoveredNodes = new Map<string, GraphNode>();
    const discoveredEdges = new Map<string, GraphEdge>();
    let boundary_reached = false;

    for (const e of edgesWithNodes ?? []) {
      const { source, target, ...edgeData } = e;
      discoveredEdges.set(e.id, edgeData as GraphEdge);
      
      if (source) {
        discoveredNodes.set(e.source_node, source as GraphNode);
      } else if (e.source_node !== nodeId) {
        boundary_reached = true;
      }

      if (target) {
        discoveredNodes.set(e.target_node, target as GraphNode);
      } else if (e.target_node !== nodeId) {
        boundary_reached = true;
      }
    }

    return {
      nodes: Array.from(discoveredNodes.values()),
      edges: Array.from(discoveredEdges.values()),
      boundary_reached,
    };
  });
}

/**
 * Get the most recently updated nodes in the graph.
 */
export async function getRecentNodes(
  ctx: RLSContext,
  limit = 10
): Promise<QueryResult> {
  return withRLS(ctx, async (supabase) => {
    const { data, error } = await supabase
      .from("kg_nodes")
      .select("*")
      .eq("org_id", ctx.org_id)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`getRecentNodes failed: ${error.message}`);
    return {
      nodes: (data ?? []) as GraphNode[],
      edges: [],
      boundary_reached: false,
    };
  });
}

/**
 * Get all nodes belonging to a specific community (Leiden cluster).
 */
export async function getCommunity(
  ctx: RLSContext,
  communityId: number
): Promise<QueryResult> {
  return withRLS(ctx, async (supabase) => {
    const { data, error } = await supabase
      .from("kg_nodes")
      .select("*")
      .eq("org_id", ctx.org_id)
      .eq("community", communityId);

    if (error) throw new Error(`getCommunity failed: ${error.message}`);
    const nodes = (data ?? []) as GraphNode[];
    const nodeIds = nodes.map(n => n.id);

    if (nodeIds.length === 0) {
      return { nodes: [], edges: [], boundary_reached: false };
    }

    // Fetch edges where EITHER endpoint is in the community.
    // Using OR instead of AND ensures cross-community edges are included;
    // we post-filter in JS to keep only edges with both endpoints in-community.
    const { data: edges, error: edgeErr } = await supabase
      .from("kg_edges")
      .select("*")
      .eq("org_id", ctx.org_id)
      .or(
        `source_node.in.(${nodeIds.map(id => `"${sanitizeForPostgrest(id)}"`).join(",")}),` +
        `target_node.in.(${nodeIds.map(id => `"${sanitizeForPostgrest(id)}"`).join(",")})`
      );

    if (edgeErr) throw new Error(`getCommunity edges failed: ${edgeErr.message}`);

    // Post-filter: keep only edges where BOTH endpoints are in-community
    const nodeIdSet = new Set(nodeIds);
    const intraCommunityEdges = (edges ?? []).filter(
      (e: any) => nodeIdSet.has(e.source_node) && nodeIdSet.has(e.target_node)
    );

    return {
      nodes,
      edges: intraCommunityEdges as GraphEdge[],
      boundary_reached: false,
    };
  });
}

// ---- Entity Resolution -------------------------------------------

/**
 * Resolve a free-text entity name to a node (or ranked candidates).
 *
 * Replaces the `ilike label … limit(1)` pattern used in causal-chain.ts
 * and other tools. Resolution order: exact → alias_exact → embedding →
 * alias_embedding. Returns null when nothing matches above threshold.
 *
 * For multi-candidate use, call resolveEntity() from entity-resolver.ts directly.
 */
export async function resolveNodeByLabel(
  ctx: RLSContext,
  query: string,
  opts?: ResolveEntityOptions
): Promise<GraphNode | null> {
  const candidates = await resolveEntity(ctx, query, opts);
  if (candidates.length === 0) return null;

  const top = candidates[0];
  return withRLS(ctx, async (supabase) => {
    const { data, error } = await supabase
      .from("kg_nodes")
      .select("*")
      .eq("id", top.canonicalNodeId)
      .eq("org_id", ctx.org_id)
      .maybeSingle();

    if (error) throw new Error(`resolveNodeByLabel fetch failed: ${error.message}`);
    return (data as GraphNode) ?? null;
  });
}

export type { EntityCandidate, ResolveEntityOptions };

// ---- KG-Guided Retrieval -----------------------------------------

export type VectorChunk = {
  chunk_id: string;
  similarity: number;
  [key: string]: unknown;
};

export type KGGuidedResult = {
  /** Top-K chunks from vector similarity search */
  vectorChunks: VectorChunk[];
  /** KG entities matched by the query — provides source_documents for scoped re-ranking */
  kgNodes: GraphNode[];
  /** Document IDs surfaced by the KG that may not have ranked in top-K vector results */
  kgSourceDocIds: string[];
};

/**
 * Combines vector search with KG entity matching for richer retrieval.
 *
 * Flow:
 *   1. Run vector_search RPC for top-K chunks by cosine similarity
 *   2. Run findNodes to match entity labels in the query text
 *   3. Collect source_documents from matched KG nodes
 *
 * The caller can use kgSourceDocIds to run a second scoped vector search
 * targeting documents the KG knows are relevant, surfacing chunks that
 * might not have ranked in the initial top-K.
 *
 * This is additive — does not replace existing vectorSearch calls.
 */
export async function kgGuidedSearch(
  ctx: RLSContext,
  queryEmbedding: number[],
  queryText: string,
  topK = 10
): Promise<KGGuidedResult> {
  // P1-15: filter to the org's pinned model when shape routing is on, so a
  // mid-re-embed org never mixes similarity scores across vector spaces.
  const modelFilter = PIPELINE_SHAPE_ROUTING
    ? await fetchOrgPinnedModel(ctx.org_id).catch(() => null)
    : null;

  // Run vector search and KG entity match in parallel
  const [vectorResult, entityResult] = await Promise.all([
    withRLS(ctx, async (supabase) => {
      const { data, error } = await supabase.rpc("vector_search", {
        p_embedding: JSON.stringify(queryEmbedding),
        p_limit: topK,
        ...(modelFilter ? { p_model_filter: modelFilter } : {}),
      });
      if (error) throw new Error(`[kgGuidedSearch] vector_search failed: ${error.message}`);
      return (data ?? []) as VectorChunk[];
    }),
    findNodes(ctx, { query: queryText }, 8).catch(() => ({ nodes: [], edges: [], boundary_reached: false })),
  ]);

  const kgNodes = entityResult.nodes;
  const kgSourceDocIds = Array.from(
    new Set(kgNodes.flatMap((n) => (n.source_documents ?? []) as string[]))
  );

  return { vectorChunks: vectorResult, kgNodes, kgSourceDocIds };
}
