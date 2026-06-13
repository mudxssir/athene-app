-- ============================================================
-- P3-10 (playbook Phase 3): documents.context_summary
--
-- One cached ≤60-token "what this document is about" line per document,
-- generated once per content_hash by the doc-context generator (simple LLM tier,
-- BYOK-aware). Prepended to every chunk's EMBEDDED text by the context envelope
-- (P3-13). The raw chunk_text stored for KG/citations is never changed — the
-- summary lives only in the embedded string and this column.
--
-- Additive column; no RLS change (documents RLS already governs the row).
-- ============================================================

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS context_summary text;
