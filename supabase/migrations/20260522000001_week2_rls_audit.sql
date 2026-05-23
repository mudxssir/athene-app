-- ============================================================
-- Migration: 20260522000001_week2_rls_audit.sql
-- Domain 6 audit — data integrity & storage verification
--
-- This migration contains NO schema changes.  It is a permanent
-- record of the SQL queries used to verify that:
--
--   6A.1 — RLS is enabled on every public table
--   6A.2 — FK cascade rules are present and correct
--   6A.3 — UNIQUE constraints match the plan
--   6A.4 — vector dimensions are aligned (DB vs code default)
--   6A.5 — encrypted_key is never selected outside the RPC
--   6B.3 — every RLS policy USING clause starts with org_id check
--   6B.4 — confidential docs excluded from cross-dept search
--   6C.1 — no orphaned document_embeddings rows
--   6C.2 — no orphaned kg_nodes source_document references
--   6C.4 — updated_at trigger present for every table that has the column
--
-- Run these against staging/production with a Postgres superuser or
-- a service_role connection to validate the live schema.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 6A.1 — Tables that should have RLS enabled but currently don't
-- Expected result: 0 rows (every public table has RLS)
-- ────────────────────────────────────────────────────────────
/*
SELECT tablename
FROM   pg_tables
WHERE  schemaname = 'public'
  AND  rowsecurity = false
ORDER  BY tablename;
*/

-- ────────────────────────────────────────────────────────────
-- 6A.2 — FK cascade audit: connections delete cascades to documents
-- Expected result: 'CASCADE' for confdelete_action on both rows
-- ────────────────────────────────────────────────────────────
/*
SELECT
  c.conname          AS constraint_name,
  c.confdeltype      AS delete_action,   -- 'c' = CASCADE, 'n' = SET NULL
  child.relname      AS child_table,
  parent.relname     AS parent_table
FROM   pg_constraint c
JOIN   pg_class child  ON child.oid  = c.conrelid
JOIN   pg_class parent ON parent.oid = c.confrelid
WHERE  c.contype = 'f'
  AND  child.relname IN ('documents', 'document_embeddings', 'kg_nodes')
ORDER  BY child_table, parent_table;
*/

-- ────────────────────────────────────────────────────────────
-- 6A.3 — UNIQUE constraints: verify all 5 required constraints exist
-- Expected: 5 rows, one per constraint listed below
-- ────────────────────────────────────────────────────────────
/*
SELECT
  t.relname  AS table_name,
  i.relname  AS index_name,
  string_agg(a.attname, ', ' ORDER BY ia.attnum) AS columns
FROM   pg_index ix
JOIN   pg_class i ON i.oid = ix.indexrelid
JOIN   pg_class t ON t.oid = ix.indrelid
JOIN   pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
JOIN   pg_namespace n ON n.oid = t.relnamespace
JOIN   LATERAL unnest(ix.indkey) WITH ORDINALITY AS ia(attnum, attnum_ord)
       ON ia.attnum = a.attnum
WHERE  ix.indisunique
  AND  n.nspname = 'public'
  AND  t.relname IN ('organizations', 'org_members', 'documents', 'document_embeddings', 'kg_nodes')
GROUP  BY t.relname, i.relname
ORDER  BY table_name, index_name;
*/
-- Expected UNIQUE columns per table:
--   organizations:       clerk_org_id
--   org_members:         org_id, clerk_user_id
--   documents:           org_id, connection_id, external_id
--   document_embeddings: document_id, chunk_index
--   kg_nodes:            org_id, label, entity_type

-- ────────────────────────────────────────────────────────────
-- 6A.4 — Vector dimension alignment
-- Expected: both rows show 768
-- ────────────────────────────────────────────────────────────
/*
SELECT
  c.relname        AS table_name,
  a.attname        AS column_name,
  format_type(a.atttypid, a.atttypmod) AS data_type
FROM   pg_attribute a
JOIN   pg_class c ON c.oid = a.attrelid
WHERE  a.attname = 'embedding'
  AND  c.relname IN ('document_embeddings', 'kg_nodes')
  AND  a.attnum > 0
ORDER  BY table_name;
*/

-- ────────────────────────────────────────────────────────────
-- 6A.5 — LLM key encryption: encrypted_key never selected raw
-- Run with: grep -rn "encrypted_key\|\.select(\"\*\")\|\.select('\*')" lib/ app/
-- Then cross-check matches — zero should be outside the store_llm_key /
-- get_decrypted_llm_key RPCs. The pattern above catches both the explicit
-- column name AND wildcard select() calls on the llm_keys table.
-- (This is a code review check, not a SQL query.)
-- ────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────
-- 6B.3 — Every RLS policy USING clause has an org_id check
-- Expected: 0 rows (no policy missing org_id check)
-- ────────────────────────────────────────────────────────────
/*
SELECT
  schemaname,
  tablename,
  policyname,
  qual   -- the USING expression
FROM   pg_policies
WHERE  schemaname = 'public'
  AND  qual IS NOT NULL
  AND  qual NOT LIKE '%org_id%'
  AND  tablename NOT IN ('organizations')   -- organizations uses id, not org_id
ORDER  BY tablename, policyname;
*/

-- ────────────────────────────────────────────────────────────
-- 6B.4 — Confidential docs excluded from cross-dept vector search
-- Verify the function body of vector_search_cross_dept contains the filter
-- Expected: 1 row, prosrc contains 'confidential'
-- ────────────────────────────────────────────────────────────
/*
SELECT
  proname,
  prosrc LIKE '%confidential%' AS excludes_confidential
FROM   pg_proc
WHERE  proname = 'vector_search_cross_dept';
*/

-- ────────────────────────────────────────────────────────────
-- 6C.1 — Orphaned document_embeddings (no parent document row)
-- Expected: 0 rows
-- ────────────────────────────────────────────────────────────
/*
SELECT COUNT(*) AS orphaned_embeddings
FROM   document_embeddings de
LEFT JOIN documents d ON d.id = de.document_id
WHERE  d.id IS NULL;
*/

-- ────────────────────────────────────────────────────────────
-- 6C.2 — Orphaned kg_nodes source_document references
-- Expected: 0 rows (all referenced document IDs exist)
-- ────────────────────────────────────────────────────────────
/*
SELECT
  kn.id   AS node_id,
  kn.label,
  sd      AS missing_document_id
FROM   kg_nodes kn,
       LATERAL unnest(kn.source_documents) AS sd
LEFT JOIN documents d ON d.id = sd
WHERE  d.id IS NULL;
*/

-- ────────────────────────────────────────────────────────────
-- 6C.4 — updated_at trigger coverage
-- Expected: all tables with updated_at column also have a trigger
-- ────────────────────────────────────────────────────────────
/*
WITH tables_with_col AS (
  SELECT c.relname AS table_name
  FROM   pg_attribute a
  JOIN   pg_class c ON c.oid = a.attrelid
  WHERE  a.attname = 'updated_at'
    AND  c.relkind = 'r'
    AND  c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
),
tables_with_trigger AS (
  SELECT DISTINCT c.relname AS table_name
  FROM   pg_trigger t
  JOIN   pg_class c ON c.oid = t.tgrelid
  WHERE  t.tgname LIKE 'trg_%_updated_at'
)
SELECT
  twc.table_name,
  CASE WHEN twt.table_name IS NULL THEN 'MISSING TRIGGER' ELSE 'OK' END AS trigger_status
FROM   tables_with_col twc
LEFT JOIN tables_with_trigger twt USING (table_name)
ORDER  BY table_name;
*/

-- No DDL executed — this migration is documentation-only.
-- DO block used instead of bare SELECT so pg_dump / migration runners that
-- strip plain SELECT statements still register this file as executed.
DO $$ BEGIN END $$;
