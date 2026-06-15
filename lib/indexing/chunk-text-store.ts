// ============================================================
// chunk-text-store.ts — single choke point for persisted chunk text (P0-6)
//
// Chunk text is persisted inside document_embeddings.metadata under the
// 'chunk_text' key (zero-copy design: KG extraction and small-to-big
// retrieval re-read it instead of re-fetching the live source).
//
// EVERY read or write of that key in application code goes through this
// module, so the planned encryption flip (playbook P7: per-org AES-GCM via
// the KMS-derived org key) is a change to these two functions plus a
// re-encryption job — not a refactor hunt.
//
// Known non-TS reader: the vector_search RPC family COALESCEs
// metadata->>'chunk_text' in SQL (supabase/migrations/*vector_search*).
// When encryption lands, those RPCs must return the raw metadata value and
// decryption moves to the app-side row mapping (retrieval-agent), or the
// column moves out of metadata entirely. Tracked in playbook P7 item 1.
// ============================================================

import { CHUNK_TEXT_ENCRYPTION } from '@/lib/config/feature-flags'
import { encryptChunkText, decryptChunkText, isEncrypted } from './chunk-crypto'

/** Preview written to content_preview: redacted (no plaintext at rest) when encrypting. */
export function chunkPreview(content: string): string {
  return CHUNK_TEXT_ENCRYPTION ? '' : content.slice(0, 200)
}

/**
 * Returns a metadata object carrying the persisted chunk text.
 * Spread-merges on top of the base metadata; never mutates the input.
 * When CHUNK_TEXT_ENCRYPTION is on and an orgId is supplied, the text is stored
 * as a per-org AES-GCM envelope (P7); otherwise plaintext (unchanged).
 */
export function writeChunkText(
  baseMeta: Record<string, unknown>,
  text: string,
  orgId?: string,
): Record<string, unknown> {
  const stored = CHUNK_TEXT_ENCRYPTION && orgId ? encryptChunkText(text, orgId) : text
  return { ...baseMeta, chunk_text: stored }
}

/**
 * Reads the stored chunk text from a document_embeddings row shape.
 * Transparently decrypts an `encv1:` envelope using the row's org_id (no caller
 * signature change). Falls back to content_preview for pre-zero-copy rows;
 * returns null when neither is usable (incl. a failed decrypt — tamper/wrong key).
 */
export function readChunkText(row: {
  metadata?: unknown
  content_preview?: string | null
  org_id?: string | null
}): string | null {
  const meta = row.metadata as Record<string, unknown> | null | undefined
  const fromMeta = meta?.['chunk_text']
  if (typeof fromMeta === 'string' && fromMeta.trim().length > 0) {
    if (isEncrypted(fromMeta)) {
      const orgId = row.org_id ?? (meta?.['org_id'] as string | undefined) ?? ''
      const dec = decryptChunkText(fromMeta, orgId)
      if (dec && dec.trim().length > 0) return dec.trim()
      // decrypt failed → fall through to preview (redacted/empty under encryption)
    } else {
      return fromMeta.trim()
    }
  }
  const preview = row.content_preview?.trim()
  return preview && preview.length > 0 ? preview : null
}

/**
 * True when the row's text came from the full stored chunk_text (false =
 * content_preview fallback or nothing). Lets callers keep telemetry about
 * short-text fallbacks (builder.ts shortTextChunks counter).
 */
export function hasFullChunkText(row: { metadata?: unknown }): boolean {
  const fromMeta = (row.metadata as Record<string, unknown> | null | undefined)?.[
    'chunk_text'
  ]
  return typeof fromMeta === 'string' && fromMeta.trim().length > 0
}
