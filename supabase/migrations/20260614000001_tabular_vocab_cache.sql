-- ============================================================
-- P4-2 (playbook Phase 4): tabular_vocab_cache
--
-- Caches the LLM-generated business-vocabulary alias line per (org, schema hash)
-- so vocabulary enrichment is one cheap-tier call per DISTINCT schema, not per
-- table per sync. The schema hash is derived from the column names+types, so a
-- table whose schema is unchanged reuses the cached alias line across re-indexes
-- and across tables that share a schema.
--
-- alias_line is generated text (business synonyms for technical column names) —
-- NOT row content. Service-role write from the indexing path; admin read for
-- debugging. Mirrors sync_skips / media_queue RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS tabular_vocab_cache (
  org_id       uuid NOT NULL,
  schema_hash  text NOT NULL,
  alias_line   text NOT NULL,
  table_name   text,                     -- last table that populated this hash (debug only)
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, schema_hash)
);

ALTER TABLE tabular_vocab_cache ENABLE ROW LEVEL SECURITY;

-- Admin-only read; writes via service role from the indexing path.
CREATE POLICY tabular_vocab_cache_admin_read ON tabular_vocab_cache FOR SELECT
  USING (
    org_id::text = app_setting('org_id')
    AND app_setting('user_role') = 'admin'
  );
