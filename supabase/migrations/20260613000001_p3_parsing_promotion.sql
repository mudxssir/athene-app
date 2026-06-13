-- ============================================================
-- P3 (playbook Phase 3): parsing-promotion foundations
--
-- 1. organizations.external_parsing_allowed — per-org opt-in for LlamaParse
--    (lane 2 of the tiered cascade). Default FALSE: an org's bytes never leave
--    our boundary for a hosted parser unless an admin explicitly allows it.
--    The sidecar (lane 1) and the in-process TS parsers (lane 3) stay within
--    the deployment, so they need no opt-in.
--
-- 2. media_queue — image/figure references discovered during parsing
--    (Docling pictures, Notion image blocks, later Slack/Gmail attachments).
--    Populated starting P3 as STUBS (status 'pending'); the P5 caption worker
--    consumes it. Created now so the picture-stub write path has a home and the
--    P5 work is purely the worker, not the schema.
--
--    Per playbook P5 spec: (org_id, source_doc_id, sha256, origin, bytes_ref,
--    status, attempts). bytes_ref is a pointer (URL / storage key / provider
--    resource id) — raw bytes are NOT stored here (no content at rest in a
--    queue table). sha256 enables org-wide dedup (repeated-logo skip).
-- ============================================================

-- 1. LlamaParse opt-in ────────────────────────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS external_parsing_allowed boolean NOT NULL DEFAULT false;

-- 2. media_queue ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  source_doc_id  text NOT NULL,            -- external_id / chunk_id of the parent document
  sha256         text,                     -- content hash for dedup (null until bytes fetched)
  origin         text NOT NULL,            -- 'docling_picture' | 'notion_image' | 'gmail_attachment' | ...
  bytes_ref      text,                     -- pointer (URL / storage key / provider resource id); NOT raw bytes
  caption        text,                     -- filled by the P5 worker; null while pending
  status         text NOT NULL DEFAULT 'pending',  -- pending | processing | done | deferred | failed | skipped
  attempts       int  NOT NULL DEFAULT 0,
  skip_reason    text,                     -- why a terminal skip/failed row was not captioned
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- One row per (doc, image) — re-parsing a document is idempotent on the queue.
  UNIQUE (org_id, source_doc_id, origin, bytes_ref)
);

CREATE INDEX IF NOT EXISTS idx_media_queue_pending
  ON media_queue (org_id, status, created_at)
  WHERE status = 'pending';

-- Org-wide dedup lookups (repeated logo / shared asset across documents).
CREATE INDEX IF NOT EXISTS idx_media_queue_sha
  ON media_queue (org_id, sha256)
  WHERE sha256 IS NOT NULL;

ALTER TABLE media_queue ENABLE ROW LEVEL SECURITY;

-- Admin-only read (queue depth shown in admin sync-health); writes via service
-- role from the parsing adapters and the P5 caption worker. Mirrors sync_skips.
CREATE POLICY media_queue_admin_read ON media_queue FOR SELECT
  USING (
    org_id::text = app_setting('org_id')
    AND app_setting('user_role') = 'admin'
  );
