export const dynamic = 'force-dynamic';

// ============================================================
// api/worker/checkpoint-prune/route.ts — Thread checkpoint pruning
//
// Called by QStash cron daily at 2 AM UTC.
//
// Problem: thread_checkpoints and threads accumulate unboundedly.
// Left unchecked, a large org (~1K active users × 10 threads/month)
// will reach 100K+ checkpoint rows within a year, degrading query
// performance and bloating storage.
//
// Strategy (two-pass):
//   Pass 1 — Soft cleanup: delete thread_checkpoints rows for threads
//     inactive >30 days. The threads rows survive so metadata is retained.
//     ON DELETE CASCADE handles thread_checkpoints automatically if a
//     thread is deleted, but here we target just checkpoints to keep
//     thread history browsable without storing full graph state.
//
//   Pass 2 — Hard cleanup: delete thread rows (and cascaded checkpoints)
//     for threads inactive >90 days with 0 messages or null titles —
//     these are likely abandoned sessions from onboarding/testing.
//
// LangGraph's PostgresSaver tables (checkpoints, checkpoint_blobs,
// checkpoint_writes) are cleaned up via direct DELETE using thread_id.
// ============================================================

import { NextResponse } from 'next/server';
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify';
import { supabaseAdmin } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

const CHECKPOINT_STALE_DAYS = 30;
const THREAD_ABANDON_DAYS   = 90;
const BATCH_SIZE = 200;

export async function POST(request: Request): Promise<Response> {
  const isValid = await verifyQStashSignature(request);
  if (!isValid) return new Response('Invalid QStash signature', { status: 401 });

  // Idempotency guard (5C.3): this cron runs daily, and the Redis TTL is 24h.
  // If QStash re-delivers after a slow response or timeout, the second call
  // will be a no-op rather than re-running the potentially expensive batch delete.
  const isFirstDelivery = await checkIdempotency(request);
  if (!isFirstDelivery) {
    logger.warn({}, '[checkpoint-prune] Duplicate delivery detected — skipping');
    return NextResponse.json({ skipped: true, reason: 'duplicate' });
  }

  const now = new Date();
  const checkpointCutoff = new Date(now.getTime() - CHECKPOINT_STALE_DAYS * 86400_000).toISOString();
  const abandonCutoff    = new Date(now.getTime() - THREAD_ABANDON_DAYS   * 86400_000).toISOString();

  let checkpointRowsDeleted = 0;
  let threadsDeleted = 0;

  // ── Pass 1: delete custom thread_checkpoints for stale threads ──────────
  // Fetch thread IDs in batches to avoid large IN clauses.
  // Two separate queries are used instead of a nested and() inside or() to
  // avoid relying on PostgREST-specific string filter syntax that may not
  // parse correctly through the supabase-js query builder.
  let offset = 0;
  while (true) {
    // Threads that had activity but not recently
    const { data: staleByDate, error: errA } = await supabaseAdmin
      .from('threads')
      .select('id')
      .lt('last_message_at', checkpointCutoff)
      .order('id')
      .range(offset, offset + BATCH_SIZE - 1);

    // Threads that were created long ago and never had a message
    const { data: staleByCreate, error: errB } = await supabaseAdmin
      .from('threads')
      .select('id')
      .is('last_message_at', null)
      .lt('created_at', checkpointCutoff)
      .order('id')
      .range(offset, offset + BATCH_SIZE - 1);

    if (errA) {
      logger.error({ err: errA.message }, '[checkpoint-prune] Failed to fetch stale threads (by date)');
      break;
    }
    if (errB) {
      logger.error({ err: errB.message }, '[checkpoint-prune] Failed to fetch stale threads (by create)');
      break;
    }

    // Merge and deduplicate IDs from both queries
    const ids = [...new Set([
      ...(staleByDate?.map((t) => t.id) ?? []),
      ...(staleByCreate?.map((t) => t.id) ?? []),
    ])];

    if (ids.length === 0) break;

    const { count, error: delErr } = await supabaseAdmin
      .from('thread_checkpoints')
      .delete({ count: 'exact' })
      .in('thread_id', ids);

    if (delErr) {
      logger.error({ err: delErr.message }, '[checkpoint-prune] Checkpoint delete failed');
    } else {
      checkpointRowsDeleted += count ?? 0;
    }

    // Stop when both sub-queries returned fewer rows than the batch limit
    if (
      (staleByDate?.length ?? 0) < BATCH_SIZE &&
      (staleByCreate?.length ?? 0) < BATCH_SIZE
    ) break;
    offset += BATCH_SIZE;
  }

  // ── Pass 2: hard-delete abandoned threads (>90 days, no messages) ───────
  const { data: abandonedThreads, error: abErr } = await supabaseAdmin
    .from('threads')
    .select('id')
    .lt('created_at', abandonCutoff)
    .or('last_message_at.is.null,message_count.eq.0');

  if (abErr) {
    logger.error({ err: abErr.message }, '[checkpoint-prune] Failed to fetch abandoned threads');
  } else if (abandonedThreads && abandonedThreads.length > 0) {
    const ids = abandonedThreads.map((t) => t.id);

    // Delete in chunks (cascades to thread_checkpoints via FK)
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      const { count: deleted, error: tDelErr } = await supabaseAdmin
        .from('threads')
        .delete({ count: 'exact' })
        .in('id', chunk);

      if (tDelErr) {
        logger.error({ err: tDelErr.message }, '[checkpoint-prune] Thread delete failed');
      } else {
        threadsDeleted += deleted ?? 0;
      }
    }
  }

  logger.info({ checkpointRowsDeleted, threadsDeleted }, '[checkpoint-prune] Run complete');
  return NextResponse.json({ checkpointRowsDeleted, threadsDeleted });
}
