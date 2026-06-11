-- ============================================================
-- P1-8: vector_search RPCs updated for small-to-big retrieval
--
-- When a matched child chunk has parent_chunk_index IS NOT NULL, the
-- RPC JOINs the parent row (same document_id, chunk_index = parent_chunk_index)
-- and returns the parent's stored chunk_text as the LLM context instead of
-- the smaller child text.
--
-- Fallback chain for chunk_text returned to callers:
--   1. parent_de.metadata->>'chunk_text'   (parent row's full text — new)
--   2. de.metadata->>'chunk_text'           (child's own text — existing)
--   3. de.content_preview                   (200-char snippet — legacy fallback)
--   4. ''                                   (empty — never reached for indexed rows)
--
-- The JOIN is a LEFT JOIN: pre-P1-8 rows with parent_chunk_index=NULL will not
-- match any parent row and fall back to their own text transparently.
--
-- Returns a new `parent_chunk_index` column so callers can identify
-- whether small-to-big expansion occurred.
-- ============================================================

-- ---- 1. vector_search (org-scoped, member/admin) --------------------------

CREATE OR REPLACE FUNCTION vector_search (
  p_embedding     vector(768),
  p_limit         int     DEFAULT 10,
  p_min_similarity float8 DEFAULT 0.0
)
RETURNS TABLE (
  chunk_id           uuid,
  document_id        uuid,
  chunk_text         text,
  content_preview    text,
  title              text,
  chunk_index        int,
  parent_chunk_index int,
  source_type        text,
  external_url       text,
  department_id      uuid,
  similarity         float8
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_org_id      text := app_setting('org_id');
  v_dept_id     text := app_setting('department_id');
  v_user_role   text := app_setting('user_role');
BEGIN
  IF vector_dims(p_embedding) <> 768 THEN
    RAISE EXCEPTION
      'vector_search: embedding has % dimensions but column expects 768. '
      'Check EMBEDDING_DIMS env var and that the embedding provider matches '
      'the one used at index time.',
      vector_dims(p_embedding);
  END IF;

  RETURN QUERY
  SELECT
    de.id                                                                     AS chunk_id,
    de.document_id                                                            AS document_id,
    -- Small-to-big: return parent's text when child has a parent pointer.
    -- Fallback chain: parent text → child text → content_preview → ''
    COALESCE(
      NULLIF(TRIM(parent_de.metadata->>'chunk_text'), ''),
      NULLIF(TRIM(de.metadata->>'chunk_text'), ''),
      NULLIF(TRIM(de.content_preview), ''),
      ''
    )::text                                                                   AS chunk_text,
    LEFT(
      COALESCE(NULLIF(TRIM(de.content_preview), ''), de.metadata->>'chunk_text', ''),
      200
    )::text                                                                   AS content_preview,
    COALESCE(d.title, '')::text                                               AS title,
    de.chunk_index                                                            AS chunk_index,
    de.parent_chunk_index                                                     AS parent_chunk_index,
    COALESCE(de.source_type, d.source_type, 'unknown')::text                 AS source_type,
    COALESCE(d.external_url, '')::text                                        AS external_url,
    de.department_id                                                          AS department_id,
    (1.0 - (de.embedding <=> p_embedding))::float8                           AS similarity
  FROM document_embeddings de
  LEFT JOIN documents d ON d.id = de.document_id
  -- Small-to-big parent join: only fires for child rows (parent_chunk_index IS NOT NULL)
  LEFT JOIN document_embeddings parent_de
    ON parent_de.document_id = de.document_id
    AND parent_de.chunk_index = de.parent_chunk_index
    AND de.parent_chunk_index IS NOT NULL
  WHERE de.org_id::text = v_org_id
    AND de.embedding IS NOT NULL  -- exclude parent-only rows (no embedding to search)
    AND de.visibility != 'confidential'
    AND (
      v_user_role = 'admin'
      OR de.visibility = 'org_wide'
      OR (
        v_dept_id IS NOT NULL
        AND v_dept_id <> ''
        AND de.department_id::text = v_dept_id
      )
    )
    AND (1.0 - (de.embedding <=> p_embedding)) >= p_min_similarity
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

-- ---- 2. vector_search_cross_dept (super_user / admin only) ----------------

CREATE OR REPLACE FUNCTION vector_search_cross_dept (
  p_embedding     vector(768),
  p_limit         int     DEFAULT 20,
  p_min_similarity float8 DEFAULT 0.0
)
RETURNS TABLE (
  chunk_id           uuid,
  document_id        uuid,
  chunk_text         text,
  content_preview    text,
  title              text,
  chunk_index        int,
  parent_chunk_index int,
  source_type        text,
  external_url       text,
  department_id      uuid,
  similarity         float8
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_org_id    text := app_setting('org_id');
  v_user_role text := app_setting('user_role');
BEGIN
  IF v_user_role NOT IN ('admin', 'super_user') THEN
    RAISE EXCEPTION 'Unauthorized: cross-department search requires super_user or admin role';
  END IF;

  IF vector_dims(p_embedding) <> 768 THEN
    RAISE EXCEPTION
      'vector_search_cross_dept: embedding has % dimensions but column expects 768.',
      vector_dims(p_embedding);
  END IF;

  RETURN QUERY
  SELECT
    de.id                                                                     AS chunk_id,
    de.document_id                                                            AS document_id,
    COALESCE(
      NULLIF(TRIM(parent_de.metadata->>'chunk_text'), ''),
      NULLIF(TRIM(de.metadata->>'chunk_text'), ''),
      NULLIF(TRIM(de.content_preview), ''),
      ''
    )::text                                                                   AS chunk_text,
    LEFT(
      COALESCE(NULLIF(TRIM(de.content_preview), ''), de.metadata->>'chunk_text', ''),
      200
    )::text                                                                   AS content_preview,
    COALESCE(d.title, '')::text                                               AS title,
    de.chunk_index                                                            AS chunk_index,
    de.parent_chunk_index                                                     AS parent_chunk_index,
    COALESCE(de.source_type, d.source_type, 'unknown')::text                 AS source_type,
    COALESCE(d.external_url, '')::text                                        AS external_url,
    de.department_id                                                          AS department_id,
    (1.0 - (de.embedding <=> p_embedding))::float8                           AS similarity
  FROM document_embeddings de
  LEFT JOIN documents d ON d.id = de.document_id
  LEFT JOIN document_embeddings parent_de
    ON parent_de.document_id = de.document_id
    AND parent_de.chunk_index = de.parent_chunk_index
    AND de.parent_chunk_index IS NOT NULL
  WHERE de.org_id::text = v_org_id
    AND de.embedding IS NOT NULL
    AND de.visibility NOT IN ('confidential', 'restricted')
    AND (1.0 - (de.embedding <=> p_embedding)) >= p_min_similarity
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

-- ---- 3. Grants -----------------------------------------------------------

GRANT EXECUTE ON FUNCTION vector_search(vector, int, float8)            TO authenticated;
GRANT EXECUTE ON FUNCTION vector_search_cross_dept(vector, int, float8) TO authenticated;
-- Backward-compat grants for the 3-arg overloads (identical signatures replace prev migration)
GRANT EXECUTE ON FUNCTION vector_search(vector, int)            TO authenticated;
GRANT EXECUTE ON FUNCTION vector_search_cross_dept(vector, int) TO authenticated;
