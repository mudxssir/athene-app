// ============================================================
// lib/langgraph/nodes/retrieval-agent.ts — Hybrid retrieval (ATH-63)
//
// Runs vector search AND knowledge graph traversal in parallel.
// The graph adds "what is connected?" context (dependency chains,
// impact paths, connected teams) that vector search alone misses.
//
// Merge strategy:
//   - Vector chunks → { type: 'chunk', ... }
//   - Graph results → { type: 'graph', raw, relationships, boundaryReached }
//
// Graceful fallback: if graphQueryTool returns the empty-graph
// sentinel string or throws, we log and continue with vector-only.
// Retrieval never fails because the knowledge graph is empty.
// ============================================================

import { vectorSearchTool } from "../tools/registry";
import { graphQueryTool } from "../tools/graph-query";
import { graphTraversalTool, findNodesTool } from "../tools/graph-traversal";
import { causalChainTool } from "../tools/causal-chain";
import { AtheneStateType } from "../state";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { logger } from "@/lib/logger";
import { rerankChunks } from "@/lib/ai/reranker";

// ---- Constants ----------------------------------------------

/** Sentinel strings from graphQueryTool that indicate "no data" */
const GRAPH_EMPTY_SENTINELS = [
  "No knowledge graph data available yet.",
  "No entities found in your question to look up in the knowledge graph.",
  "Knowledge graph unavailable: missing org context.",
];

// ---- Helpers ------------------------------------------------

/**
 * Extracts the user's latest query text from the messages array.
 * Falls back to empty string if no human message is found.
 */
function extractQueryText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m instanceof HumanMessage ||
      m?.constructor?.name === "HumanMessage" ||
      m?._getType?.() === "human"
    ) {
      return typeof m.content === "string" ? m.content : String(m.content);
    }
  }
  return "";
}

/**
 * Parses the vector search tool output into typed chunk objects.
 *
 * After §4 P0-A the RPC returns both `chunk_text` (full text for LLM) and
 * `content_preview` (200-char display snippet). Chunks where both fields are
 * empty are filtered out — they're ghost rows that would inject blank context
 * into the synthesis prompt and mislead the LLM about how much data exists.
 *
 * Always returns an array — never throws.
 */
function parseVectorResults(
  raw: string
): Array<{
  type: "chunk";
  chunk_id?: string;
  document_id: string;
  score?: number;
  /**
   * Full chunk text for LLM context. Populated from `chunk_text` (new column)
   * with `content_preview` as fallback for old-indexed documents.
   */
  chunk_text: string;
  /** 200-char display snippet; also used by the cross-encoder reranker. */
  content_preview: string;
  title?: string | null;
  chunk_index: number;
  source_type: string;
  external_url?: string | null;
  department_id?: string | null;
  similarity?: number;
}> {
  try {
    const parsed = JSON.parse(raw);
    const results = parsed.results ?? parsed;
    if (!Array.isArray(results)) return [];

    const mapped = results.map((r: any) => {
      // chunk_text is the new explicit full-text column (§4 P0-A migration).
      // Fall back to content_preview for documents indexed before the migration,
      // then to the raw `content` field for any legacy shape.
      const chunkText: string =
        r.chunk_text?.trim() ||
        r.content_preview?.trim() ||
        r.content?.trim() ||
        "";

      // content_preview is the 200-char display snippet.  For old-format rows
      // that only have a single combined field, truncate to 200 chars.
      const displayPreview: string =
        r.content_preview?.trim() ||
        chunkText.slice(0, 200);

      return {
        type: "chunk" as const,
        chunk_id: r.chunk_id ?? r.id,
        document_id: r.document_id,
        score: r.similarity ?? r.score,
        chunk_text: chunkText,
        content_preview: displayPreview,
        title: r.title ?? null,
        chunk_index: r.chunk_index ?? 0,
        source_type: r.source_type ?? "unknown",
        external_url: r.external_url || null,
        department_id: r.department_id ?? null,
        similarity: r.similarity ?? r.score,
      };
    });

    // Filter ghost rows — chunks with no text at all can't contribute to
    // synthesis and would silently inflate the "chunks retrieved" count.
    const valid = mapped.filter((c) => c.chunk_text.length > 0);
    const dropped = mapped.length - valid.length;
    if (dropped > 0) {
      logger.warn(
        { dropped, total: mapped.length },
        "[retrieval] Filtered empty-text chunks — re-index affected documents"
      );
    }

    return valid;
  } catch {
    return [];
  }
}

/**
 * Parses the graph query tool output into a structured object.
 * Handles both the new JSON format (IW-2) and legacy text format.
 * Returns null if the output is a sentinel (empty graph).
 */
function parseGraphResults(raw: string): {
  type: "graph";
  raw: string;
  nodes?: any[];
  edges?: any[];
  relationships: string[];
  boundaryReached: boolean;
} | null {
  if (!raw || GRAPH_EMPTY_SENTINELS.includes(raw.trim())) {
    return null;
  }

  // Try new JSON format first (IW-2: graph-query.ts now returns JSON)
  try {
    const parsed = JSON.parse(raw);
    if (parsed.nodes !== undefined && parsed.edges !== undefined) {
      const relationships = (parsed.edges ?? []).map((e: any) => {
        const from = e.from_label ?? e.from ?? e.source_node ?? "?";
        const to = e.to_label ?? e.to ?? e.target_node ?? "?";
        return `${from} → ${e.relation} → ${to}`;
      });
      return {
        type: "graph",
        raw,
        nodes: parsed.nodes,
        edges: parsed.edges,
        relationships,
        boundaryReached: parsed.boundaryReached ?? parsed.boundary_reached ?? false,
      };
    }
  } catch {
    // Fall through to legacy text parsing
  }

  // Legacy text format fallback
  const lines = raw.split("\n");
  const relationships: string[] = [];
  let boundaryReached = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Note: boundary reached")) {
      boundaryReached = true;
    } else if (trimmed.includes("→") && line.startsWith(" ")) {
      relationships.push(trimmed);
    }
  }

  return {
    type: "graph",
    raw,
    relationships,
    boundaryReached,
  };
}

// ---- Main node function -------------------------------------

/**
 * Hybrid retrieval agent: runs vector search and graph traversal
 * in parallel, merges results into state.retrieved_chunks.
 *
 * State contract:
 *   IN:  state.messages, state.orgId, state.userId, state.role
 *   OUT: state.retrieved_chunks (merged vector + graph results)
 */
export async function retrievalAgent(
  state: AtheneStateType,
  config: any
): Promise<Partial<AtheneStateType>> {
  const { orgId, userId, role, deptId, messages } = state;
  const query = extractQueryText(messages);

  if (!query) {
    logger.warn({}, "[retrieval] No query text found in messages");
    return {
      retrieved_chunks: [],
    };
  }

  // Build the security context for tool calls — deptId is required for
  // RLS department filtering in vector_search(); without it only org_wide
  // documents are returned and department-scoped content is invisible.
  // user_role is required by graphTraversalTool's RLS context extractor.
  const toolConfig = {
    configurable: {
      ...(config?.configurable ?? {}),
      orgId,
      userId,
      role,
      deptId: deptId ?? null,
    },
    metadata: {
      ...(config?.metadata ?? {}),
      orgId,
      userId,
      role,
      user_role: role,
      deptId: deptId ?? null,
    },
  };

  // Map complexity tier to topK. BI/cross-dept queries get a larger window
  // because they need to pull stats, sample, and aggregation chunks for
  // potentially several tables before synthesis can answer analytically.
  const topKMap: Record<string, number> = { simple: 8, standard: 15, complex: 25 };
  const isBiQuery = (state as any).route === "cross_dept_retrieval";
  const topK = isBiQuery ? 30 : (topKMap[(state as any).complexity ?? "standard"] ?? 15);

  // ── Run vector search + graph lookup + entity find in parallel ────────
  const [vectorRaw, graphRaw, findNodesRaw] = await Promise.all([
    // Vector search — always runs
    vectorSearchTool
      .invoke({ query, topK }, toolConfig)
      .catch((err: unknown) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "[retrieval] Vector search failed");
        return JSON.stringify({ results: [] });
      }),

    // Graph query — graceful fallback on failure or empty graph
    graphQueryTool
      .invoke({ question: query, maxHops: 2 }, toolConfig)
      .catch((err: unknown) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "[retrieval] Graph query failed (continuing vector-only)");
        return "No knowledge graph data available yet.";
      }),

    // Entity node lookup (RLS-aware) — finds specific graph nodes by label
    findNodesTool
      .invoke({ query, limit: 5 }, toolConfig)
      .catch((): null => null),
  ]);

  // ── Deep traversal on top entities found (IW-1: graphTraversalTool) ────
  let deepTraversalResults: any[] = [];
  try {
    if (findNodesRaw) {
      const findParsed = JSON.parse(findNodesRaw as string);
      const topNodes = (findParsed.nodes ?? []).slice(0, 2);
      if (topNodes.length > 0) {
        const traversals = await Promise.all(
          topNodes.map((node: any) =>
            graphTraversalTool
              .invoke({ nodeId: node.id, maxHops: 2 }, toolConfig)
              .catch((): null => null)
          )
        );
        for (const t of traversals) {
          if (!t) continue;
          try {
            const parsed = JSON.parse(t as string);
            if ((parsed.nodes?.length ?? 0) > 0) {
              deepTraversalResults.push({
                type: "graph",
                raw: t as string,
                nodes: parsed.nodes,
                edges: parsed.edges,
                relationships: (parsed.edges ?? []).map((e: any) =>
                  `${e.source_node} → ${e.relation} → ${e.target_node}`
                ),
                boundaryReached: parsed.boundary_reached ?? false,
              });
            }
          } catch { /* ignore malformed traversal */ }
        }
      }
    }
  } catch {
    // Non-fatal — continue without deep traversal
  }

  // ── Causal chain lookup for timeline/history queries ─────────
  const CAUSAL_KEYWORDS = /\b(history|timeline|happened|when did|trace|events|incident chain|causal|chronolog|sequence of|what led)\b/i;
  let causalChainResult: any = null;
  if (CAUSAL_KEYWORDS.test(query)) {
    try {
      const causalRaw = await causalChainTool.invoke({ entityLabel: query.slice(0, 80) }, toolConfig);
      const parsed = typeof causalRaw === "string" ? JSON.parse(causalRaw) : causalRaw;
      if ((parsed.count ?? 0) > 0) {
        causalChainResult = { type: "causal_chain", ...parsed };
      }
    } catch {
      // Non-fatal — continue without causal chain
    }
  }

  // ── Parse results ─────────────────────────────────────────
  const rawVectorChunks = parseVectorResults(vectorRaw as string);

  // Cross-encoder reranking: improves relevance ordering before synthesis
  const vectorChunks = await rerankChunks(query, rawVectorChunks, Math.min(topK, 15));

  const graphResult = parseGraphResults(graphRaw as string);

  // ── Merge into unified retrieved_chunks ────────────────────
  const mergedResults: any[] = [...vectorChunks];

  if (graphResult) {
    mergedResults.push(graphResult);
  }

  // Include RLS-aware deep traversal results from graphTraversalTool
  for (const traversal of deepTraversalResults) {
    mergedResults.push(traversal);
  }

  if (causalChainResult) {
    mergedResults.push(causalChainResult);
  }

  logger.info(
    {
      query: query.slice(0, 80),
      vectorChunks: vectorChunks.length,
      graphAvailable: !!graphResult,
      deepTraversals: deepTraversalResults.length,
      causalEvents: causalChainResult?.count ?? 0,
      boundaryReached: graphResult?.boundaryReached ?? false,
    },
    "[retrieval] retrieval complete"
  );

  // Add a summary message so the supervisor can see retrieval results and
  // route to synthesis instead of looping back to retrieval.
  const summaryParts = [`[Retrieval complete] Found ${vectorChunks.length} vector chunk(s)`];
  if (graphResult) summaryParts.push("+ knowledge graph context");
  if (deepTraversalResults.length > 0) summaryParts.push(`+ ${deepTraversalResults.length} deep traversal(s)`);
  if (causalChainResult) summaryParts.push(`+ causal chain (${causalChainResult.count} events)`);
  summaryParts.push(`for query: "${query.slice(0, 100)}"`);
  const retrievalSummary = new AIMessage({ content: summaryParts.join(" ") });

  return {
    messages: [retrievalSummary],
    retrieved_chunks: mergedResults,
  };
}
