-- ============================================================
-- P1-13: Embedding model pinning
--
-- Adds per-org embedding model pinning and a needs_embedding flag
-- so that when the pinned provider is unavailable, rows can be
-- written with embedding=null and re-tried asynchronously by the
-- embed-retry QStash worker (no documents are lost, no silent
-- cross-model fallback).
--
-- COLUMN SEMANTICS:
--   organizations.embedding_model_pinned
--     The canonical embedding model for this org.
--     Default: 'jina-embeddings-v3' (the system primary).
--     Changing this triggers a re-embed job for all org docs.
--
--   document_embeddings.needs_embedding
--     true  → embedding is null because the provider was unavailable
--             when this row was written. The embed-retry worker will
--             pick this row up, embed it with the pinned model, and
--             set needs_embedding=false.
--     false → row has a valid embedding (normal state).
--
-- DEPLOY ORDER: apply before deploying code that writes needs_embedding.
-- The embed-retry worker reads needs_embedding; both must be deployed
-- together (worker reads the column only after this migration runs).
-- ============================================================

-- ---- 1. Per-org pinned model ------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS embedding_model_pinned text NOT NULL DEFAULT 'jina-embeddings-v3';

COMMENT ON COLUMN organizations.embedding_model_pinned IS
  'Canonical embedding model for this org. Factory uses only this model '
  'when PIPELINE_SHAPE_ROUTING=true. Default: jina-embeddings-v3. '
  'Changing this triggers a paced re-embed via scripts/migrations/re-embed.ts.';

-- ---- 2. Retry flag on document_embeddings ----------------------------

ALTER TABLE document_embeddings
  ADD COLUMN IF NOT EXISTS needs_embedding bool NOT NULL DEFAULT false;

COMMENT ON COLUMN document_embeddings.needs_embedding IS
  'true = embedding is null because the pinned provider was unavailable. '
  'The embed-retry worker will fill in the embedding and clear this flag. '
  'Rows with needs_embedding=true are excluded from vector_search results '
  'via embedding IS NOT NULL (already enforced by P1-8 migration).';

-- Index for the embed-retry worker: needs to find all pending rows per org.
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_needs_embedding
  ON document_embeddings (org_id, document_id)
  WHERE needs_embedding = true;

-- ---- 3. migration_jobs table (paced re-embed checkpoints) ----------
-- Used by scripts/migrations/re-embed.ts to checkpoint progress so
-- long-running re-embed jobs survive Vercel's 300-s function timeout.

CREATE TABLE IF NOT EXISTS migration_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_type      text NOT NULL,                          -- e.g. 're-embed'
  status        text NOT NULL DEFAULT 'running',        -- running|completed|failed
  last_doc_id   uuid,                                   -- resume cursor
  processed     int NOT NULL DEFAULT 0,                 -- rows processed so far
  total         int,                                    -- null until first pass
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_migration_jobs_org_type
  ON migration_jobs (org_id, job_type, status);

-- RLS: only service-role can write; no user-facing access needed.
ALTER TABLE migration_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "migration_jobs_service_role_all"
  ON migration_jobs FOR ALL
  USING (false);  -- service-role bypasses RLS

-- ---- 4. sync_errors DLQ table ----------------------------------------
-- Dead-letter queue for background job failures visible in the admin
-- sync-health page. All workers write here on fatal failure.

CREATE TABLE IF NOT EXISTS sync_errors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_type     text NOT NULL,
  document_id  uuid,
  connection_id uuid,
  error        text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (org_id, job_type, document_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_errors_org_occurred
  ON sync_errors (org_id, occurred_at DESC);

ALTER TABLE sync_errors ENABLE ROW LEVEL SECURITY;

-- Admins can read sync errors for their org; service-role can write.
CREATE POLICY "sync_errors_admin_read"
  ON sync_errors FOR SELECT
  USING (
    org_id::text = current_setting('app.org_id', true)
    AND current_setting('app.user_role', true) = 'admin'
  );
