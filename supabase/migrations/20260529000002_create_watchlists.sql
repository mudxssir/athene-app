-- Watchlists: standing queries that Athene monitors on a schedule.
-- When the answer changes materially, an alert row is created.

CREATE TABLE IF NOT EXISTS watchlists (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid        NOT NULL,
  user_id             uuid        NOT NULL,
  name                text        NOT NULL,
  query               text        NOT NULL,
  schedule            text        NOT NULL DEFAULT '0 9 * * 1-5',  -- cron (9am Mon-Fri)
  last_run_at         timestamptz,
  last_answer         text,
  last_answer_hash    text,
  last_cited_sources  jsonb       NOT NULL DEFAULT '[]',
  notify_channels     jsonb       NOT NULL DEFAULT '[{"type":"in_app"}]',
  is_active           boolean     NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist_alerts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id      uuid        NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  org_id            uuid        NOT NULL,
  user_id           uuid        NOT NULL,
  previous_answer   text,
  new_answer        text        NOT NULL,
  change_summary    text        NOT NULL,
  severity          text        NOT NULL DEFAULT 'info'
                                CHECK (severity IN ('info', 'warning', 'critical')),
  cited_sources     jsonb       NOT NULL DEFAULT '[]',
  is_read           boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS watchlists_org_id_idx          ON watchlists (org_id);
CREATE INDEX IF NOT EXISTS watchlists_user_id_idx         ON watchlists (user_id);
CREATE INDEX IF NOT EXISTS watchlists_is_active_idx       ON watchlists (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS watchlist_alerts_watchlist_idx  ON watchlist_alerts (watchlist_id);
CREATE INDEX IF NOT EXISTS watchlist_alerts_user_unread    ON watchlist_alerts (user_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS watchlist_alerts_org_created    ON watchlist_alerts (org_id, created_at DESC);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_watchlists_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS watchlists_updated_at ON watchlists;
CREATE TRIGGER watchlists_updated_at
  BEFORE UPDATE ON watchlists
  FOR EACH ROW EXECUTE FUNCTION update_watchlists_updated_at();

-- RLS
ALTER TABLE watchlists       ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist_alerts ENABLE ROW LEVEL SECURITY;

-- Watchlists: users manage their own; admins see org-wide
CREATE POLICY "watchlists_select" ON watchlists FOR SELECT
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.user_id = auth.uid()
        AND org_members.org_id  = watchlists.org_id
        AND org_members.role    IN ('admin', 'super_user')
    )
  );

CREATE POLICY "watchlists_insert" ON watchlists FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.user_id = auth.uid()
        AND org_members.org_id  = watchlists.org_id
    )
  );

CREATE POLICY "watchlists_update" ON watchlists FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "watchlists_delete" ON watchlists FOR DELETE
  USING (user_id = auth.uid());

-- Alerts: users see their own
CREATE POLICY "watchlist_alerts_select" ON watchlist_alerts FOR SELECT
  USING (user_id = auth.uid());

-- Service role bypasses RLS for worker upserts
