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
-- 3B.3 — No stale chunks (chunk_index gaps indicate a failed prune)
--
-- Definitive detection of stale chunks requires knowing the expected
-- chunk count per document, which is only available by re-running the
-- indexer.  The two SQL-level checks below are complementary proxies:
--
-- Check A: documents where (max_chunk_index + 1) ≠ total chunk rows.
--   A healthy document has contiguous 0-based indices, so
--   max_index = count - 1.  Any deviation means either a gap
--   (over-pruned) or an extra row (under-pruned / stale).
--   Expected: 0 rows.
--
-- Check B: documents with an abnormally high chunk count (> 50).
--   Most documents should produce far fewer chunks.  A very high
--   count suggests repeated indexing without pruning.
--   Expected: investigate any rows returned.
-- ────────────────────────────────────────────────────────────

-- Check A — non-contiguous chunk indices per document
/*
SELECT
  document_id,
  COUNT(*)         AS chunk_rows,
  MAX(chunk_index) AS max_idx
FROM   document_embeddings
GROUP  BY document_id
HAVING MAX(chunk_index) <> COUNT(*) - 1
ORDER  BY chunk_rows DESC
LIMIT  50;
*/

-- Check B — documents with suspiciously high chunk counts
/*
SELECT
  document_id,
  COUNT(*) AS chunk_count
FROM   document_embeddings
GROUP  BY document_id
HAVING COUNT(*) > 50
ORDER  BY chunk_count DESC
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
-- 4C.1 — HITL audit completeness: every approved/rejected action
--         has a row in hitl_decisions
--
-- ⚠  FALSE-POSITIVE WARNING: most threads never reach a write
--    action that triggers HITL, so they will legitimately have
--    no hitl_decisions row.  The query below is intentionally
--    scoped to threads whose checkpoint state shows a past
--    awaiting_approval=true → false transition, which is not
--    directly queryable here.
--
-- Practical proxy: join to hitl_decisions and look for threads
-- that DO have a decision row to confirm the audit trail exists.
-- Cross-reference with application logs for threads that triggered
-- write actions but show no matching hitl_decisions row.
--
-- Positive check — confirm audit rows exist at all
-- Expected: non-zero (at least some HITL decisions recorded)
-- ────────────────────────────────────────────────────────────
/*
SELECT
  hd.thread_id,
  hd.action,
  hd.decided_by,
  hd.decided_at
FROM   hitl_decisions hd
WHERE  hd.decided_at > now() - interval '7 days'
ORDER  BY hd.decided_at DESC
LIMIT  50;
*/

-- Negative check — threads with pending_write_action set but no decision
-- (only meaningful if your threads table has a pending_write_action column)
/*
SELECT
  t.id AS thread_id,
  t.org_id,
  t.updated_at
FROM   threads t
WHERE  t.updated_at > now() - interval '7 days'
  AND  t.pending_write_action IS NOT NULL
  AND  (t.awaiting_approval IS NULL OR t.awaiting_approval = false)
  AND  NOT EXISTS (
    SELECT 1
    FROM   hitl_decisions hd
    WHERE  hd.thread_id = t.id
  )
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
