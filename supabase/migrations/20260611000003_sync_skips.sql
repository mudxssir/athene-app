-- ============================================================
-- P0-5 (playbook / audit D11+D12): sync_skips — skipped-content telemetry
--
-- Every drop path in the ingestion pipeline (skip-sentinels, unsupported
-- binaries, oversized files) records WHY content was not indexed, so silent
-- data loss becomes visible in admin sync health.
--
-- connection_id is text, not a FK: the central indexing path records the
-- internal connections.id UUID, while fetcher-side drops (e.g. Drive's
-- unsupported-format branch) only hold the Nango connection id string.
-- Both are useful; neither should block the write.
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_skips (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  connection_id text NOT NULL,
  external_id   text NOT NULL,
  title         text,
  reason        text NOT NULL,
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, connection_id, external_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_sync_skips_org ON sync_skips (org_id, last_seen DESC);

ALTER TABLE sync_skips ENABLE ROW LEVEL SECURITY;

-- Admin-only read; writes happen via service role from background workers.
CREATE POLICY sync_skips_admin_read ON sync_skips FOR SELECT
  USING (
    org_id::text = app_setting('org_id')
    AND app_setting('user_role') = 'admin'
  );
