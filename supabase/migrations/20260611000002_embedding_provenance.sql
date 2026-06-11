-- ============================================================
-- P0-3 (playbook): embedding provenance columns
--
-- embedding_model   — which model produced the vector. NULL = pre-P0 row
--                     (handled by the P1 re-embed migration).
-- pipeline_version  — chunking/indexing pipeline version that wrote the row;
--                     bumped whenever a shape's chunk policy changes so the
--                     reindex worker can find stale rows.
-- shape             — data shape (PLAN_A §0.1); stamped from P1 onward.
--
-- Columns are additive; no RLS change required (existing policies are
-- row-scoped, not column-scoped).
-- ============================================================

ALTER TABLE document_embeddings
  ADD COLUMN IF NOT EXISTS embedding_model text,
  ADD COLUMN IF NOT EXISTS pipeline_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS shape text;

COMMENT ON COLUMN document_embeddings.embedding_model IS
  'Embedding model that produced this vector (e.g. jina-embeddings-v3). NULL = legacy pre-P0 row.';
COMMENT ON COLUMN document_embeddings.pipeline_version IS
  'Indexing pipeline version that wrote this row; rows below the current version are re-index candidates.';
COMMENT ON COLUMN document_embeddings.shape IS
  'Data shape (prose|email|thread|work_item|record|tabular|bi_artifact|media|code). NULL until P1 shape routing.';

-- Mixed-model detection + re-embed candidate scans
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_model
  ON document_embeddings (org_id, embedding_model);
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_pipeline_version
  ON document_embeddings (org_id, pipeline_version);
