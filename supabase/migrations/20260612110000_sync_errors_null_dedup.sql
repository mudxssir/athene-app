-- ============================================================
-- P1 review fix #7: sync_errors dedup with NULL document_id
--
-- The original UNIQUE (org_id, job_type, document_id) treats NULLs as
-- distinct (SQL three-valued logic), so connection-level job failures —
-- which have no document_id — accumulate one new row per occurrence
-- instead of refreshing a single row via upsert.
--
-- Fix: recreate the constraint with NULLS NOT DISTINCT (Postgres 15+)
-- so (org_id, job_type, NULL) collides with itself and the workers'
-- upsert(..., { onConflict: 'org_id,job_type,document_id' }) dedups
-- connection-level errors the same way it dedups document-level ones.
-- ============================================================

-- 1. Collapse existing duplicate NULL-document rows, keeping the most recent.
DELETE FROM sync_errors a
USING sync_errors b
WHERE a.org_id = b.org_id
  AND a.job_type = b.job_type
  AND a.document_id IS NULL
  AND b.document_id IS NULL
  AND (a.occurred_at < b.occurred_at
       OR (a.occurred_at = b.occurred_at AND a.ctid < b.ctid));

-- 2. Swap the constraint.
ALTER TABLE sync_errors
  DROP CONSTRAINT IF EXISTS sync_errors_org_id_job_type_document_id_key;

ALTER TABLE sync_errors
  ADD CONSTRAINT sync_errors_org_job_doc_key
  UNIQUE NULLS NOT DISTINCT (org_id, job_type, document_id);

COMMENT ON CONSTRAINT sync_errors_org_job_doc_key ON sync_errors IS
  'NULLS NOT DISTINCT so connection-level errors (document_id IS NULL) '
  'dedup on upsert instead of accumulating one row per failure.';
