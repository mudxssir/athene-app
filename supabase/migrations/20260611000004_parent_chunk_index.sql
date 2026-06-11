-- ============================================================
-- P1-8: small-to-big retrieval foundation
--
-- Adds parent_chunk_index to document_embeddings so that child
-- chunks (small, precise, embedded) can point to a parent row
-- (larger context window, not embedded, returned at retrieval).
--
-- Retrieval semantics (enforced by the updated vector_search RPC
-- in migration 20260611000005_vector_search_parent.sql):
--   • child row  — parent_chunk_index IS NOT NULL  — has embedding, used for search
--   • parent row — parent_chunk_index IS NULL       — text only, returned instead of child
--
-- When a search matches a child row, the RPC JOINs the parent row
-- (same document_id, chunk_index = parent_chunk_index) and returns
-- the parent's stored chunk_text. Falls back to child's text when
-- the parent row is absent (backward-compat for pre-P1-8 rows).
--
-- DEPLOY ORDER: apply this migration before deploying the indexing
-- code that writes parent_chunk_index. PostgREST rejects payloads
-- with unknown columns and would fail ALL embedding writes otherwise.
-- ============================================================

ALTER TABLE document_embeddings
  ADD COLUMN IF NOT EXISTS parent_chunk_index int;

COMMENT ON COLUMN document_embeddings.parent_chunk_index IS
  'Chunk index of the parent row in the same document. NULL = this row IS the parent (or a standalone chunk with no parent). Non-null = child chunk; retrieval returns parent''s chunk_text for context.';

-- Index for the parent JOIN in vector_search (document_id + parent_chunk_index lookup)
CREATE INDEX IF NOT EXISTS idx_doc_embeddings_parent
  ON document_embeddings (document_id, parent_chunk_index)
  WHERE parent_chunk_index IS NOT NULL;

-- For integrity: every child row should have a parent row in the same document.
-- This is enforced at the application level (indexing.ts), not as a FK, to keep
-- the upsert logic simple (parents are written first, children second).
