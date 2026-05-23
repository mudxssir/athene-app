-- ============================================================
-- Migration: 20260523000001_week3_pipeline_audit.sql
-- Domain 3 & 4 audit — integration pipeline & agent runtime verification
--
-- This migration contains NO schema changes.  It is a permanent
-- record of the SQL queries used to verify that:
--
--   3A.2 — OAuth tokens are never stored in Supabase
--   3A.3 — Embedding dimensions are aligned (DB vs code vs RPCs)
--   3B.2 — Every document_embeddings row has a valid org_id
--   3B.3 — No stale chunks exist (chunk_index beyond the current max)
--   3B.6 — Visibility column uses only defined enum values
--   3C.1 — No orphaned document_embeddings after a connection delete
--   4A.1 — Agent threads reference only internal UUIDs (not Clerk IDs)
--   4C.1 — Every HITL decision has an audit row in hitl_decisions
--   4C.4 — cited_sources document_ids all exist in the documents table
--
-- Run these against staging/production with a Postgres superuser or
-- a service_role connection to validate the live schema and data.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 3A.2 — OAuth tokens never stored in Supabase
-- Verify: no column named 'access_token' or 'refresh_token' exists
--         outside of pg_catalog.
-- Expected: 0 rows (no token columns in public schema)
-- ────────────────────────────────────────────────────────────
/*
SELECT
  c.table_name,
  c.column_name
FROM   information_schema.columns c
WHERE  c.table_schema = 'public'
  AND  c.column_name IN ('access_token', 'refresh_token', 'bearer_token')
ORDER  BY table_name, column_name;
*/

-- ────────────────────────────────────────────────────────────
-- 3A.3 — Embedding dimension alignment
-- Expected: all rows show typmod = 768 (vector(768) = typmod 772)
-- ────────────────────────────────────────────────────────────
/*
SELECT
  c.relname      AS table_name,
  a.attname      AS column_name,
  format_type(a.atttypid, a.atttypmod) AS data_type
FROM   pg_attribute a
JOIN   pg_class c ON c.oid = a.attrelid
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  n.nspname = 'public'
  AND  a.attname IN ('embedding', 'label_embedding')
  AND  a.attnum > 0
  AND  NOT a.attisdropped
ORDER  BY table_name, column_name;
-- Also check the RPC parameter types:
SELECT
  proname,
  pg_get_function_arguments(oid) AS args
FROM   pg_proc
WHERE  proname IN ('vector_search', 'vector_search_cross_dept')
ORDER  BY proname;
*/

-- ────────────────────────────────────────────────────────────
-- 3B.2 — Org isolation: no document_embeddings row without org_id
-- Expected: 0 rows
-- ────────────────────────────────────────────────────────────
/*
SELECT COUNT(*) AS missing_org_id
FROM   document_embeddings
WHERE  org_id IS NULL;
*/

-- ────────────────────────────────────────────────────────────
-- 3B.3 — No stale chunks (chunk_index beyond current max per document)
-- A stale chunk is one whose index is higher than the highest valid
-- chunk for that document.  This would indicate a failed prune.
-- Expected: 0 rows
-- ────────────────────────────────────────────────────────────
/*
WITH max_chunks AS (
  SELECT
    document_id,
    MAX(chunk_index) AS max_idx,
    COUNT(*)         AS total
  FROM   document_embeddings
  GROUP  BY document_id
),
expected_max AS (
  -- The maximum valid chunk_index is total - 1 (0-indexed).
  -- Any chunk_index = max_idx that equals total-1 is fine.
  -- A stale chunk would be gap-free but exceed actual content count.
  -- Best proxy: look for documents where chunk indices are not contiguous.
  SELECT
    e.document_id,
    generate_series(0, mc.max_idx) AS expected_idx
  FROM   document_embeddings e
  JOIN   max_chunks mc ON mc.document_id = e.document_id
)
SELECT
  de.document_id,
  de.chunk_index
FROM   document_embeddings de
LEFT JOIN expected_max em
  ON em.document_id = de.document_id
 AND em.expected_idx = de.chunk_index
WHERE  em.expected_idx IS NULL  -- chunk exists but was not expected
LIMIT  50;
*/

-- ────────────────────────────────────────────────────────────
-- 3B.6 — Visibility values are valid
-- Expected: 0 rows (all use defined enum values)
-- ────────────────────────────────────────────────────────────
/*
SELECT DISTINCT visibility
FROM   documents
WHERE  visibility NOT IN (
  'org_wide', 'department', 'bi_accessible', 'confidential', 'restricted'
);
*/

-- ────────────────────────────────────────────────────────────
-- 3C.1 — No orphaned document_embeddings after connection delete
-- Expected: 0 rows
-- ────────────────────────────────────────────────────────────
/*
SELECT COUNT(*) AS orphaned_embeddings
FROM   document_embeddings de
LEFT JOIN documents d ON d.id = de.document_id
WHERE  d.id IS NULL;
*/

-- ────────────────────────────────────────────────────────────
-- 4A.1 — Agent threads reference only internal UUIDs (not Clerk IDs)
-- Clerk user IDs look like 'user_xxx' and org IDs like 'org_xxx'.
-- Expected: 0 rows (all IDs are valid UUID format)
-- ────────────────────────────────────────────────────────────
/*
SELECT id, org_id, user_id
FROM   threads
WHERE  org_id::text  LIKE 'org\_%' ESCAPE '\'
   OR  user_id::text LIKE 'user\_%' ESCAPE '\'
LIMIT  50;
*/

-- ────────────────────────────────────────────────────────────
-- 4C.1 — HITL audit completeness: every decision action has a row
-- This is a sampling check: look for threads in awaiting_approval=false
-- state that have no hitl_decisions row within the last 7 days.
-- (Exact verification requires checkpoint inspection — this catches obvious gaps.)
-- Expected: 0 rows (all approved/rejected actions have audit entries)
-- ────────────────────────────────────────────────────────────
/*
SELECT
  t.id           AS thread_id,
  t.org_id,
  t.updated_at
FROM   threads t
WHERE  t.updated_at > now() - interval '7 days'
  AND  NOT EXISTS (
    SELECT 1
    FROM   hitl_decisions hd
    WHERE  hd.thread_id = t.id
  )
  -- Only flag threads that had activity (message_count > 0)
  AND  t.message_count > 0
ORDER  BY t.updated_at DESC
LIMIT  50;
*/

-- ────────────────────────────────────────────────────────────
-- 4C.4 — All cited_sources document_ids exist in documents table
-- The documents JSONB column in hitl_decisions.original_payload and
-- agent responses is not directly queryable — validate via the
-- documents table join instead:
-- Run with: grep -rn "cited_sources\|document_id" lib/langgraph/nodes/synthesis-agent.ts
-- Verify: extractCitations() only populates CitedSource from vectorChunks
--         (which were fetched FROM the DB), not from user-supplied text.
-- (Code review check — no SQL needed.)
-- ────────────────────────────────────────────────────────────

-- No DDL executed — this migration is documentation-only.
-- DO block used instead of bare SELECT so pg_dump / migration runners
-- that strip plain SELECT statements still register this file as executed.
DO $$ BEGIN END $$;
