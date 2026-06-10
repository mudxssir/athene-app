// ============================================================
// lib/knowledge-graph/config.ts — centralised KG thresholds
//
// All numeric thresholds that were previously inline constants
// live here so they can be reviewed and tuned in one place.
// ============================================================

export const KG_CONFIG = {
  entity_resolution: {
    // Above this → same entity, set canonical_id (hard merge)
    merge_similarity_threshold: 0.92,
    // Above this, below merge → different surface form of same entity, register alias
    alias_similarity_threshold: 0.80,
    // If top-2 candidate similarities are within this margin, treat as ambiguous
    disambiguation_margin: 0.05,
    // Max candidates returned from resolveEntity()
    max_candidates: 5,
  },
  extraction: {
    // Parallel chunk concurrency in extractEntitiesAndRelations()
    concurrency: 5,
    // Redis TTL for cached extraction prompt (seconds)
    prompt_cache_ttl_s: 600,
  },
  community: {
    // Nodes per batch in community ID update pass
    batch_size: 100,
  },
  backfill: {
    // Nodes processed per backfill worker invocation
    batch_size: 50,
    // Redis/Supabase cursor key prefix
    cursor_key_prefix: "kg_entity_resolution_backfill",
  },
} as const;
