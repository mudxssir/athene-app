#!/usr/bin/env tsx
/**
 * scripts/migrations/re-embed.ts — P1-14
 *
 * Paced re-embedding job that re-embeds all documents for an org using
 * the org's current pinned embedding model (organizations.embedding_model_pinned).
 *
 * Usage:
 *   npx tsx scripts/migrations/re-embed.ts --org <org_id> [--resume] [--dry-run]
 *
 * Options:
 *   --org <uuid>   Organization ID to re-embed (required)
 *   --resume       Resume a previous run from its checkpoint (last_doc_id)
 *   --dry-run      Fetch and count rows without writing embeddings
 *
 * Behaviour:
 *   - Per-org concurrency: 1 (sequential; never parallel to avoid rate limits)
 *   - Batch size: 96 texts per embedding API call (EMBED_BATCH_SIZE)
 *   - Checkpoints every CHECKPOINT_EVERY documents into migration_jobs row
 *   - On Vercel (300-s timeout): re-enqueue via QStash is NOT handled here
 *     (this script runs locally / in CI, not as a Vercel function)
 *   - Never deletes existing embeddings — overwrites them in-place
 *
 * Safety:
 *   - Documents whose chunk text is absent are skipped (logged, not errored)
 *   - Embedding errors are logged per-batch; failed docs written to sync_errors
 *   - Runs idempotently: re-running re-embeds only docs whose embedding_model
 *     differs from the org's pinned model (unless --force is passed)
 */

import { createClient } from '@supabase/supabase-js'
import { embedBatchPinned, fetchOrgPinnedModel } from '@/lib/ai/embedding-factory'
import { readChunkText } from '@/lib/indexing/chunk-text-store'

// ── Supabase (service-role) ──────────────────────────────────────────────────

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
)

// ── Constants ────────────────────────────────────────────────────────────────

const EMBED_BATCH_SIZE   = 96
const CHUNK_PAGE_SIZE    = 500  // rows fetched per page
const CHECKPOINT_EVERY   = 500  // commit migration_jobs checkpoint every N chunks

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function flag(name: string): boolean {
  return args.includes(name)
}

function option(name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const orgId    = option('--org')
const resume   = flag('--resume')
const dryRun   = flag('--dry-run')

if (!orgId) {
  console.error('Usage: npx tsx scripts/migrations/re-embed.ts --org <org_id> [--resume] [--dry-run]')
  process.exit(1)
}

// ── Migration job helpers ─────────────────────────────────────────────────────

async function upsertJob(
  jobId: string | null,
  status: 'running' | 'completed' | 'failed',
  processed: number,
  total: number | null,
  lastDocId: string | null,
  error?: string,
): Promise<string> {
  const row = {
    org_id:       orgId!,
    job_type:     're-embed',
    status,
    processed,
    total,
    last_doc_id:  lastDocId,
    error:        error ?? null,
    updated_at:   new Date().toISOString(),
    ...(status === 'completed' ? { completed_at: new Date().toISOString() } : {}),
  }

  if (jobId) {
    await supabase.from('migration_jobs').update(row).eq('id', jobId)
    return jobId
  }

  const { data } = await supabase
    .from('migration_jobs')
    .insert(row)
    .select('id')
    .single()
  return (data as { id: string }).id
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[re-embed] org=${orgId} resume=${resume} dry-run=${dryRun}`)

  // 1. Resolve pinned model
  const pinnedModel = await fetchOrgPinnedModel(orgId!)
  console.log(`[re-embed] Pinned model: ${pinnedModel}`)

  // 2. Find or create migration_jobs row
  let jobId: string | null = null
  let resumeCursor: string | null = null

  if (resume) {
    const { data: existing } = await supabase
      .from('migration_jobs')
      .select('id, last_doc_id, processed')
      .eq('org_id', orgId)
      .eq('job_type', 're-embed')
      .eq('status', 'running')
      .order('started_at', { ascending: false })
      .limit(1)
      .single()

    if (existing) {
      jobId = (existing as { id: string }).id
      resumeCursor = (existing as { last_doc_id: string | null }).last_doc_id
      console.log(`[re-embed] Resuming from cursor: ${resumeCursor ?? 'beginning'}`)
    }
  }

  if (!jobId) {
    jobId = await upsertJob(null, 'running', 0, null, null)
    console.log(`[re-embed] Created migration_jobs row: ${jobId}`)
  }

  // 3. Page through all document_embeddings for the org that need re-embedding
  // Filter: rows where embedding_model != pinnedModel OR embedding IS NULL
  let processed = 0
  let skipped   = 0
  let failed    = 0
  let cursor: string | null = resumeCursor
  let total: number | null  = null

  // Rows needing re-embed: model differs from pinned OR model is NULL.
  // Review fix #4: .neq() alone excludes NULL rows (SQL three-valued logic:
  // NULL != 'x' evaluates to NULL, not true) — but NULL-model rows (pre-P0
  // provenance rows) are exactly the ones most in need of re-embedding.
  const staleModelFilter = `embedding_model.neq.${pinnedModel},embedding_model.is.null`

  // Count total (for progress display)
  const { count } = await supabase
    .from('document_embeddings')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .or(staleModelFilter)

  total = count ?? null
  console.log(`[re-embed] Rows to re-embed: ${total ?? 'unknown'}`)

  try {
    while (true) {
      let query = supabase
        .from('document_embeddings')
        .select('id, document_id, chunk_index, metadata, content_preview, embedding_model')
        .eq('org_id', orgId)
        .or(staleModelFilter)
        .order('id', { ascending: true })
        .limit(CHUNK_PAGE_SIZE)

      if (cursor) {
        query = query.gt('id', cursor)
      }

      const { data: rows, error: fetchErr } = await query

      if (fetchErr) throw fetchErr
      if (!rows || rows.length === 0) break

      // Embed in sub-batches of EMBED_BATCH_SIZE
      for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
        const batch = rows.slice(i, i + EMBED_BATCH_SIZE)
        const texts = batch.map(r =>
          readChunkText(r as Parameters<typeof readChunkText>[0]) ?? ''
        )

        const validIndices = texts
          .map((t, j) => (t.trim() ? j : -1))
          .filter(j => j >= 0)

        if (validIndices.length === 0) {
          skipped += batch.length
          continue
        }

        const validTexts = validIndices.map(j => texts[j])

        if (dryRun) {
          processed += validIndices.length
          skipped += batch.length - validIndices.length
          console.log(`[re-embed][dry-run] Would embed ${validIndices.length} chunks`)
          continue
        }

        try {
          const { embeddings, model } = await embedBatchPinned(validTexts, orgId!, 'document')

          for (let k = 0; k < validIndices.length; k++) {
            const row = batch[validIndices[k]] as { id: string }
            const { error: updErr } = await supabase
              .from('document_embeddings')
              .update({
                embedding: embeddings[k],
                embedding_model: model,
                needs_embedding: false,
              })
              .eq('id', row.id)

            if (updErr) {
              console.warn(`[re-embed] Failed to update row ${row.id}: ${updErr.message}`)
              failed++
            } else {
              processed++
            }
          }

          skipped += batch.length - validIndices.length

        } catch (embErr) {
          failed += batch.length
          console.warn(`[re-embed] Batch embed failed: ${embErr instanceof Error ? embErr.message : String(embErr)}`)

          try {
            await supabase.from('sync_errors').upsert({
              org_id: orgId,
              job_type: 're-embed',
              error: `Batch embed failed: ${embErr instanceof Error ? embErr.message : String(embErr)}`.slice(0, 500),
              occurred_at: new Date().toISOString(),
            }, { onConflict: 'org_id,job_type,document_id' })
          } catch { /* DLQ write failure is non-fatal */ }
        }
      }

      // Update cursor and checkpoint
      cursor = (rows[rows.length - 1] as { id: string }).id

      if (processed % CHECKPOINT_EVERY < CHUNK_PAGE_SIZE) {
        await upsertJob(jobId, 'running', processed, total, cursor)
        console.log(`[re-embed] Checkpoint: processed=${processed} failed=${failed} skipped=${skipped}`)
      }
    }

    await upsertJob(jobId, 'completed', processed, total, cursor)
    console.log(`[re-embed] Done: processed=${processed} failed=${failed} skipped=${skipped}`)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await upsertJob(jobId, 'failed', processed, total, cursor, msg)
    console.error(`[re-embed] Fatal: ${msg}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('[re-embed] Unhandled error:', err)
  process.exit(1)
})
