export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ============================================================
// app/api/worker/embed-retry/route.ts — P1-13
//
// QStash-triggered worker that retries embedding for document rows
// where needs_embedding=true (written when the pinned embedding
// provider was unavailable during initial indexing).
//
// Payload: { org_id: string, document_id: string }
//
// Flow:
//   1. Verify QStash signature
//   2. Check idempotency
//   3. Fetch all needs_embedding=true rows for the document
//   4. Re-embed their chunk texts using the org's pinned model
//   5. Update each row with the embedding, clear needs_embedding
//   6. On total failure: write to sync_errors (DLQ)
// ============================================================

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { parseBody, uuidSchema } from '@/lib/validation'
import { embedBatchPinned } from '@/lib/ai/embedding-factory'
import { readChunkText } from '@/lib/indexing/chunk-text-store'
import type { EmbeddingHint } from '@/lib/ai/embedding-factory'

// ---- Payload schema ----------------------------------------------

const EmbedRetrySchema = z.object({
  org_id:      uuidSchema,
  document_id: uuidSchema,
})

// ---- Batch size --------------------------------------------------

const RETRY_BATCH = 96  // matches EMBED_BATCH_SIZE in indexing.ts

// ---- POST handler ------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const isValid = await verifyQStashSignature(request)
  if (!isValid) {
    return NextResponse.json({ error: 'Invalid QStash signature' }, { status: 401 })
  }

  const isFirstTime = await checkIdempotency(request)
  if (!isFirstTime) {
    logger.info('[embed-retry] Skipping duplicate job (idempotency)')
    return NextResponse.json({ status: 'ok', skipped: 'duplicate' })
  }

  let raw: unknown
  try { raw = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsed = parseBody(EmbedRetrySchema, raw)
  if (!parsed.success) return parsed.response
  const { org_id, document_id } = parsed.data

  logger.info({ org_id, document_id }, '[embed-retry] Processing')

  try {
    // 1. Fetch all pending rows for this document
    const { data: rows, error: fetchErr } = await supabaseAdmin
      .from('document_embeddings')
      .select('id, chunk_index, metadata, content_preview, source_type, department_id')
      .eq('org_id', org_id)
      .eq('document_id', document_id)
      .eq('needs_embedding', true)
      .order('chunk_index', { ascending: true })

    if (fetchErr) throw fetchErr
    if (!rows || rows.length === 0) {
      logger.info({ org_id, document_id }, '[embed-retry] No pending rows — already completed or doc gone')
      return NextResponse.json({ status: 'ok', retried: 0 })
    }

    logger.info({ org_id, document_id, pendingRows: rows.length }, '[embed-retry] Retrying embeddings')

    // 2. Extract chunk texts from metadata (readChunkText falls back to content_preview)
    const texts: string[] = rows.map(row => readChunkText(row as Parameters<typeof readChunkText>[0]) ?? '')
    const hint: EmbeddingHint = 'document'  // re-embed uses document hint (conservative default)

    // 3. Re-embed in batches using the org's pinned model
    let retried = 0
    let failed = 0

    for (let i = 0; i < rows.length; i += RETRY_BATCH) {
      const batchRows = rows.slice(i, i + RETRY_BATCH)
      const batchTexts = texts.slice(i, i + RETRY_BATCH)

      // Skip rows with no recoverable text
      const validIndices = batchTexts
        .map((t, j) => (t.trim() ? j : -1))
        .filter(j => j >= 0)

      if (validIndices.length === 0) {
        failed += batchRows.length
        continue
      }

      const validTexts = validIndices.map(j => batchTexts[j])

      try {
        const { embeddings, model } = await embedBatchPinned(validTexts, org_id, hint)

        const updates = validIndices.map((j, k) => ({
          id: (batchRows[j] as { id: string }).id,
          embedding: embeddings[k],
          embedding_model: model,
          needs_embedding: false,
        }))

        for (const upd of updates) {
          const { error: updErr } = await supabaseAdmin
            .from('document_embeddings')
            .update({
              embedding: upd.embedding,
              embedding_model: upd.embedding_model,
              needs_embedding: false,
            })
            .eq('id', upd.id)
            .eq('org_id', org_id)

          if (updErr) {
            logger.warn({ id: upd.id, err: updErr.message }, '[embed-retry] Failed to update row (non-fatal)')
            failed++
          } else {
            retried++
          }
        }
      } catch (embErr) {
        failed += batchRows.length
        logger.warn(
          { document_id, batchStart: i, err: embErr instanceof Error ? embErr.message : String(embErr) },
          '[embed-retry] Batch embedding failed'
        )
      }
    }

    if (failed > 0) {
      // DLQ: write to sync_errors so admin sync-health surface shows the failure
      try {
        await supabaseAdmin.from('sync_errors').upsert({
          org_id,
          job_type: 'embed-retry',
          document_id,
          error: `embed-retry: ${failed} rows still pending after retry`,
          occurred_at: new Date().toISOString(),
        }, { onConflict: 'org_id,job_type,document_id' })
      } catch { /* DLQ write failure is non-fatal */ }
    }

    logger.info({ org_id, document_id, retried, failed }, '[embed-retry] Done')
    return NextResponse.json({ status: 'ok', retried, failed })

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ org_id, document_id, err: message }, '[embed-retry] Fatal error')

    // DLQ
    try {
      await supabaseAdmin.from('sync_errors').upsert({
        org_id,
        job_type: 'embed-retry',
        document_id,
        error: message.slice(0, 500),
        occurred_at: new Date().toISOString(),
      }, { onConflict: 'org_id,job_type,document_id' })
    } catch { /* DLQ write failure is non-fatal */ }

    return NextResponse.json({ error: message }, { status: 500 })
  }
}
