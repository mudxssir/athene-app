-- Entity Resolution: kg_node_aliases + resolve_entity() + find_similar_nodes()
--
-- Problem: "payments-svc" (GitHub), "Payments Service" (Jira), "billing thing" (Slack)
-- become separate nodes. This migration adds the alias table and SQL functions that
-- power multi-source entity resolution without duplicate nodes.
--
-- Three-tier resolution order (TypeScript layer enforces):
--   1. Exact label/alias match  → similarity 1.0
--   2. Alias embedding search   → similarity in [alias_threshold, merge_threshold)
--   3. Label embedding search   → same range
-- Disambiguation: if top-2 candidates within 0.05 similarity, return both to caller.

-- ── Alias table ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kg_node_aliases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  node_id         uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  alias           text NOT NULL CHECK (length(alias) BETWEEN 1 AND 500),
  alias_embedding vector(768),
  source          text NOT NULL,   -- 'github' | 'jira' | 'slack' | 'extraction' | 'backfill'
  confidence      float NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, node_id, alias)
);

-- Fast exact-match lookup (lower-cased)
CREATE INDEX IF NOT EXISTS kg_node_aliases_org_alias_idx
  ON kg_node_aliases (org_id, lower(alias));

-- ANN search for alias embeddings
CREATE INDEX IF NOT EXISTS kg_node_aliases_embedding_idx
  ON kg_node_aliases USING ivfflat (alias_embedding vector_cosine_ops)
  WITH (lists = 50)
  WHERE alias_embedding IS NOT NULL;

-- Node-side lookup (e.g. "get all aliases for node X")
CREATE INDEX IF NOT EXISTS kg_node_aliases_node_idx
  ON kg_node_aliases (org_id, node_id);

-- ── RLS ────────────────────────────────────────────────────────────────────────

ALTER TABLE kg_node_aliases ENABLE ROW LEVEL SECURITY;

-- Org isolation only: visibility is enforced on the parent kg_nodes query.
-- Service-role (supabaseAdmin) bypasses RLS for writes/backfill.
CREATE POLICY kg_node_aliases_org_read ON kg_node_aliases
  FOR SELECT
  USING (org_id::text = app_setting('org_id'));

-- ── resolve_entity() RPC ───────────────────────────────────────────────────────
--
-- Unified entity lookup replacing bare ilike limit(1) calls.
-- Priority: exact > alias_exact > embedding > alias_embedding.
-- Deduplicates by canonical_node_id (via COALESCE with canonical_id).
-- Returns up to p_limit candidates ordered by similarity DESC.

CREATE OR REPLACE FUNCTION resolve_entity(
  p_org_id       uuid,
  p_query        text,
  p_embedding    vector(768),
  p_entity_type  text    DEFAULT NULL,
  p_threshold    float   DEFAULT 0.80,
  p_limit        int     DEFAULT 5
)
RETURNS TABLE (
  node_id          uuid,
  canonical_node_id uuid,
  label            text,
  entity_type      text,
  match_source     text,
  similarity       float
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    -- 1. Exact label match
    SELECT
      n.id                               AS node_id,
      COALESCE(n.canonical_id, n.id)     AS canonical_node_id,
      n.label, n.entity_type,
      'exact'::text                      AS match_source,
      1.0::float                         AS similarity
    FROM kg_nodes n
    WHERE n.org_id = p_org_id
      AND lower(n.label) = lower(p_query)
      AND (p_entity_type IS NULL OR n.entity_type = p_entity_type)

    UNION ALL

    -- 2. Exact alias match
    SELECT
      n.id                               AS node_id,
      COALESCE(n.canonical_id, n.id)     AS canonical_node_id,
      n.label, n.entity_type,
      'alias_exact'::text                AS match_source,
      1.0::float                         AS similarity
    FROM kg_node_aliases a
    JOIN kg_nodes n ON n.id = a.node_id AND n.org_id = p_org_id
    WHERE a.org_id = p_org_id
      AND lower(a.alias) = lower(p_query)
      AND (p_entity_type IS NULL OR n.entity_type = p_entity_type)

    UNION ALL

    -- 3. Label embedding similarity
    SELECT
      n.id                               AS node_id,
      COALESCE(n.canonical_id, n.id)     AS canonical_node_id,
      n.label, n.entity_type,
      'embedding'::text                  AS match_source,
      (1 - (n.label_embedding <=> p_embedding))::float AS similarity
    FROM kg_nodes n
    WHERE n.org_id = p_org_id
      AND n.label_embedding IS NOT NULL
      AND (p_entity_type IS NULL OR n.entity_type = p_entity_type)
      AND (1 - (n.label_embedding <=> p_embedding)) >= p_threshold

    UNION ALL

    -- 4. Alias embedding similarity
    SELECT
      n.id                               AS node_id,
      COALESCE(n.canonical_id, n.id)     AS canonical_node_id,
      n.label, n.entity_type,
      'alias_embedding'::text            AS match_source,
      (1 - (a.alias_embedding <=> p_embedding))::float AS similarity
    FROM kg_node_aliases a
    JOIN kg_nodes n ON n.id = a.node_id AND n.org_id = p_org_id
    WHERE a.org_id = p_org_id
      AND a.alias_embedding IS NOT NULL
      AND (p_entity_type IS NULL OR n.entity_type = p_entity_type)
      AND (1 - (a.alias_embedding <=> p_embedding)) >= p_threshold
  ),
  -- Keep best match per canonical entity (dedup cross-source aliases)
  ranked AS (
    SELECT DISTINCT ON (canonical_node_id)
      node_id, canonical_node_id, label, entity_type, match_source, similarity
    FROM candidates
    ORDER BY canonical_node_id, similarity DESC
  )
  SELECT node_id, canonical_node_id, label, entity_type, match_source, similarity
  FROM ranked
  ORDER BY similarity DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION resolve_entity IS
  'Multi-source entity lookup: exact → alias_exact → embedding → alias_embedding. '
  'Returns ranked candidates deduped by canonical node. Replaces bare ilike+limit(1) lookups.';

-- ── find_similar_nodes() RPC ───────────────────────────────────────────────────
--
-- Used by the backfill job to find similar root nodes for a given node.
-- Excludes the queried node itself; only matches root nodes (canonical_id IS NULL).

CREATE OR REPLACE FUNCTION find_similar_nodes(
  p_org_id      uuid,
  p_node_id     uuid,
  p_embedding   vector(768),
  p_entity_type text,
  p_threshold   float DEFAULT 0.80,
  p_limit       int   DEFAULT 5
)
RETURNS TABLE (node_id uuid, label text, similarity float)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    id   AS node_id,
    label,
    (1 - (label_embedding <=> p_embedding))::float AS similarity
  FROM kg_nodes
  WHERE org_id      = p_org_id
    AND entity_type = p_entity_type
    AND label_embedding IS NOT NULL
    AND canonical_id IS NULL
    AND id != p_node_id
    AND (1 - (label_embedding <=> p_embedding)) >= p_threshold
  ORDER BY label_embedding <=> p_embedding
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION find_similar_nodes IS
  'ANN search for root nodes similar to the given node. Used by the entity resolution backfill job.';
