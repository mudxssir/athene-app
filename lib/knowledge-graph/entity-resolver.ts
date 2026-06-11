// ============================================================
// lib/knowledge-graph/entity-resolver.ts
//
// Multi-source entity resolution replacing bare ilike+limit(1) calls.
//
// Resolution order (per resolve_entity() SQL RPC):
//   1. Exact label match           (similarity 1.0, source 'exact')
//   2. Exact alias match           (similarity 1.0, source 'alias_exact')
//   3. Label embedding similarity  (source 'embedding')
//   4. Alias embedding similarity  (source 'alias_embedding')
//
// Disambiguation: if top-2 candidates are within KG_CONFIG.entity_resolution
// .disambiguation_margin of each other, both are returned and the caller
// must decide (pick top, log warning, or surface to user).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
// SERVICE-ROLE JUSTIFICATION: supabaseAdmin is used only by registerAlias(),
// a background write path invoked from extraction/backfill jobs where no
// user RLS context exists. All read paths go through withRLS().
import { supabaseAdmin } from "@/lib/supabase/server";
import { embed } from "@/lib/ai/embedder";
import { logger } from "@/lib/logger";
import { KG_CONFIG } from "./config";

export interface EntityCandidate {
  nodeId: string;
  canonicalNodeId: string;
  label: string;
  entityType: string;
  matchSource: "exact" | "alias_exact" | "embedding" | "alias_embedding";
  similarity: number;
}

export interface ResolveEntityOptions {
  entityType?: string;
  limit?: number;
  // Skip embedding if you only want exact/alias_exact matches (faster, no embed call)
  exactOnly?: boolean;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Resolve a free-text entity name to ranked KG node candidates.
 * Runs inside withRLS() — org isolation and visibility are enforced.
 */
export async function resolveEntity(
  ctx: RLSContext,
  query: string,
  opts?: ResolveEntityOptions
): Promise<EntityCandidate[]> {
  return withRLS(ctx, (supabase) => _resolve(supabase, ctx.org_id, query, opts));
}

/**
 * Convenience wrapper: returns the canonical node ID of the top-ranked
 * candidate, or null if nothing matches above threshold.
 * Logs a warning if disambiguation is needed.
 */
export async function resolveNodeId(
  ctx: RLSContext,
  query: string,
  opts?: ResolveEntityOptions
): Promise<string | null> {
  const candidates = await resolveEntity(ctx, query, opts);
  return _pickTopId(candidates, query);
}

/**
 * Register a surface-form alias for an existing canonical node.
 * Best-effort — failure is logged but not thrown (alias is non-critical metadata).
 * Uses service-role so it can be called from extraction/backfill contexts.
 */
export async function registerAlias(
  orgId: string,
  nodeId: string,
  alias: string,
  source: string,
  confidence: number,
  embedding?: number[]
): Promise<void> {
  try {
    const row: Record<string, unknown> = {
      org_id: orgId,
      node_id: nodeId,
      alias: alias.trim().slice(0, 500),
      source,
      confidence: Math.max(0, Math.min(1, confidence)),
    };
    if (embedding) row.alias_embedding = embedding;

    const { error } = await supabaseAdmin
      .from("kg_node_aliases")
      .upsert(row, { onConflict: "org_id,node_id,alias", ignoreDuplicates: true });

    if (error) {
      logger.warn(
        { orgId, nodeId, alias, err: error.message },
        "[entity-resolver] registerAlias failed"
      );
    }
  } catch (err) {
    logger.warn(
      { orgId, nodeId, alias, err: err instanceof Error ? err.message : String(err) },
      "[entity-resolver] registerAlias unexpected error"
    );
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function _resolve(
  supabase: SupabaseClient,
  orgId: string,
  query: string,
  opts?: ResolveEntityOptions
): Promise<EntityCandidate[]> {
  const q = query.trim();
  if (!q) return [];

  const limit = opts?.limit ?? KG_CONFIG.entity_resolution.max_candidates;

  // Generate embedding unless exactOnly mode
  let embedding: number[] | null = null;
  if (!opts?.exactOnly) {
    try {
      // 'query' hint (P0-2): label lookups search against passage-embedded node labels —
      // query/passage is the intended asymmetric pairing on Google/Jina providers.
      embedding = await embed(q, orgId, "query");
    } catch (err) {
      logger.warn(
        { orgId, query: q, err: err instanceof Error ? err.message : String(err) },
        "[entity-resolver] Embedding failed — falling back to exact-only resolution"
      );
    }
  }

  const { data, error } = await (supabase as any).rpc("resolve_entity", {
    p_org_id:      orgId,
    p_query:       q,
    p_embedding:   embedding ?? new Array(768).fill(0),
    p_entity_type: opts?.entityType ?? null,
    p_threshold:   KG_CONFIG.entity_resolution.alias_similarity_threshold,
    p_limit:       limit,
  });

  if (error) {
    logger.error({ orgId, query: q, err: error.message }, "[entity-resolver] resolve_entity RPC failed");
    return [];
  }

  return ((data ?? []) as any[]).map((row) => ({
    nodeId:          row.node_id,
    canonicalNodeId: row.canonical_node_id,
    label:           row.label,
    entityType:      row.entity_type,
    matchSource:     row.match_source as EntityCandidate["matchSource"],
    similarity:      row.similarity,
  }));
}

function _pickTopId(candidates: EntityCandidate[], query: string): string | null {
  if (candidates.length === 0) return null;

  const top = candidates[0];
  const second = candidates[1];

  if (
    second &&
    top.similarity - second.similarity < KG_CONFIG.entity_resolution.disambiguation_margin &&
    top.matchSource !== "exact" &&
    top.matchSource !== "alias_exact"
  ) {
    logger.warn(
      {
        query,
        top:    { label: top.label, sim: top.similarity },
        second: { label: second.label, sim: second.similarity },
      },
      "[entity-resolver] Ambiguous entity — top-2 within disambiguation margin; picking top candidate"
    );
  }

  return top.canonicalNodeId;
}
