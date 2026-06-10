-- ============================================================
-- Migration: vector_search_robustness  (§4 P0-A)
--
-- Previous migrations fixed the missing-chunk-text bug by returning
-- COALESCE(metadata->>'chunk_text', content_preview) under the alias
-- `content_preview`.  This migration hardens both RPCs further:
--
--   1. Split chunk_text (full LLM context) from content_preview
--      (200-char display snippet) into explicit separate columns so
--      the TypeScript layer can use each for its correct purpose.
--
--   2. Add `title` from the documents JOIN so citations can show a
--      human-readable name instead of a raw UUID.
--
--   3. Add p_min_similarity (default 0.0) so callers can filter out
--      low-relevance noise before it reaches synthesis.
--
--   4. Fix NULL department_id: when `app_setting('department_id')`
--      is empty the IS NOT DISTINCT FROM clause correctly limits
--      non-admin users to org_wide content only — the previous
--      equality check `de.department_id::text = NULL` was always
--      FALSE in SQL, meaning no-dept users saw zero dept-scoped docs.
--      Admin role bypasses the department filter entirely.
--
--   5. Raise an explicit exception if the embedding vector length does
--      not match the column dimension — prevents silent garbage results
--      when a query is embedded with a different provider than the index.
-- ============================================================

-- ---- 1. vector_search (org-scoped, member/admin) --------------------------

CREATE OR REPLACE FUNCTION vector_search (
  p_embedding     vector(768),
  p_limit         int     DEFAULT 10,
  p_min_similarity float8 DEFAULT 0.0
)
RETURNS TABLE (
  chunk_id        uuid,
  document_id     uuid,
  chunk_text      text,      -- full stored text (metadata->>'chunk_text' or content_preview)
  content_preview text,      -- 200-char UI snippet (always truncated)
  title           text,      -- document title for citations
  chunk_index     int,
  source_type     text,
  external_url    text,
  department_id   uuid,
  similarity      float8     -- float8 = double precision (more accurate than float4)
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_org_id      text := app_setting('org_id');
  v_dept_id     text := app_setting('department_id');
  v_user_role   text := app_setting('user_role');
BEGIN
  -- Guard: reject mismatched embedding dimensions immediately rather than
  -- letting pgvector silently return junk cosine scores.
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
    -- Full text for LLM context: stored chunk_text takes priority, 200-char
    -- content_preview is a fallback for old-indexed docs (pre-zero-copy).
    COALESCE(
      NULLIF(TRIM(de.metadata->>'chunk_text'), ''),
      NULLIF(TRIM(de.content_preview), ''),
      ''
    )::text                                                                   AS chunk_text,
    -- Truncated snippet for UI display only (never sent to the LLM).
    LEFT(
      COALESCE(NULLIF(TRIM(de.content_preview), ''), de.metadata->>'chunk_text', ''),
      200
    )::text                                                                   AS content_preview,
    COALESCE(d.title, '')::text                                               AS title,
    de.chunk_index                                                            AS chunk_index,
    COALESCE(de.source_type, d.source_type, 'unknown')::text                 AS source_type,
    COALESCE(d.external_url, '')::text                                        AS external_url,
    de.department_id                                                          AS department_id,
    (1.0 - (de.embedding <=> p_embedding))::float8                           AS similarity
  FROM document_embeddings de
  LEFT JOIN documents d ON d.id = de.document_id
  WHERE de.org_id::text = v_org_id
    -- Visibility / department filter:
    --   admin  → sees all non-confidential content in the org
    --   member → org_wide always visible; dept-scoped visible only when dept matches
    --            if the user has no dept assignment they see org_wide only
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
  chunk_id        uuid,
  document_id     uuid,
  chunk_text      text,
  content_preview text,
  title           text,
  chunk_index     int,
  source_type     text,
  external_url    text,
  department_id   uuid,
  similarity      float8
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
    COALESCE(de.source_type, d.source_type, 'unknown')::text                 AS source_type,
    COALESCE(d.external_url, '')::text                                        AS external_url,
    de.department_id                                                          AS department_id,
    (1.0 - (de.embedding <=> p_embedding))::float8                           AS similarity
  FROM document_embeddings de
  LEFT JOIN documents d ON d.id = de.document_id
  WHERE de.org_id::text = v_org_id
    -- Hard walls that must hold even for cross-dept super_users:
    --   confidential → strictly need-to-know, never cross-dept
    --   restricted   → personal/private, never cross-dept
    AND de.visibility NOT IN ('confidential', 'restricted')
    AND (1.0 - (de.embedding <=> p_embedding)) >= p_min_similarity
  ORDER BY similarity DESC
  LIMIT p_limit;
END;
$$;

-- ---- 3. Grant execute to authenticated role --------------------------------

GRANT EXECUTE ON FUNCTION vector_search(vector, int, float8)            TO authenticated;
GRANT EXECUTE ON FUNCTION vector_search_cross_dept(vector, int, float8) TO authenticated;

-- Keep old overloads working (backward compat for any direct SQL callers
-- that don't pass the new params — drops when Postgres resolves by arg count).
-- The two-arg signatures from the previous migration are superseded by the
-- three-arg signatures above; no explicit DROP needed because
-- CREATE OR REPLACE with a different signature creates a new overload.
GRANT EXECUTE ON FUNCTION vector_search(vector, int)            TO authenticated;
GRANT EXECUTE ON FUNCTION vector_search_cross_dept(vector, int) TO authenticated;
