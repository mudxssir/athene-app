// ============================================================
// lib/indexing/re-encrypt.ts — P7-1 (playbook Phase 7, item 1)
//
// Paced, resumable re-encryption of existing plaintext chunk_text into per-org
// AES-GCM envelopes (and redaction of the plaintext content_preview). Pages
// document_embeddings by id cursor; already-encrypted rows are skipped, so the
// migration is idempotent and safe to resume after an interruption.
//
// This is the data side of the encryption flip: flip CHUNK_TEXT_ENCRYPTION on for
// new writes, then run this once per org to bring historical rows over. Readers
// already handle mixed plaintext/ciphertext rows, so the corpus stays searchable
// throughout the migration.
//
// SERVICE-ROLE JUSTIFICATION: one-off background migration (no RLS session); reads
// + rewrites document_embeddings scoped by explicit org_id. chunk_text is handled
// only through the encrypt helper; no plaintext is logged.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { encryptChunkText, isEncrypted } from './chunk-crypto'

export const REENCRYPT_PAGE = 200
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

interface Row { id: string; metadata: Record<string, unknown> | null }

/**
 * Re-encrypt one page of an org's rows (id > cursor). Returns the page size, how
 * many were newly encrypted, and the next cursor (null when the org is done).
 */
export async function reEncryptChunkTextPage(
  orgId: string,
  cursor: string = '',
  limit: number = REENCRYPT_PAGE,
): Promise<{ processed: number; encrypted: number; nextCursor: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('document_embeddings')
    .select('id, metadata')
    .eq('org_id', orgId)
    .gt('id', cursor || ZERO_UUID)
    .order('id', { ascending: true })
    .limit(limit)
  if (error) {
    logger.warn({ orgId, err: error.message }, '[re-encrypt] page read failed')
    return { processed: 0, encrypted: 0, nextCursor: null }
  }
  const rows = (data ?? []) as Row[]
  if (rows.length === 0) return { processed: 0, encrypted: 0, nextCursor: null }

  let encrypted = 0
  for (const row of rows) {
    const ct = row.metadata?.chunk_text
    if (typeof ct !== 'string' || ct.length === 0 || isEncrypted(ct)) continue // nothing to do / already done
    const newMeta = { ...row.metadata, chunk_text: encryptChunkText(ct, orgId) }
    const { error: updErr } = await supabaseAdmin
      .from('document_embeddings')
      .update({ metadata: newMeta, content_preview: '' }) // redact plaintext preview
      .eq('id', row.id)
      .eq('org_id', orgId)
    if (updErr) logger.warn({ id: row.id, err: updErr.message }, '[re-encrypt] row update failed')
    else encrypted++
  }

  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null
  return { processed: rows.length, encrypted, nextCursor }
}

/** Re-encrypt an entire org, paging to completion. Returns totals. */
export async function reEncryptOrg(orgId: string): Promise<{ processed: number; encrypted: number }> {
  let cursor = ''
  let processed = 0
  let encrypted = 0
  for (;;) {
    const page = await reEncryptChunkTextPage(orgId, cursor)
    processed += page.processed
    encrypted += page.encrypted
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  logger.info({ orgId, processed, encrypted }, '[re-encrypt] org complete')
  return { processed, encrypted }
}
