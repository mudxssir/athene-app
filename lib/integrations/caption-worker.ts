// ============================================================
// lib/integrations/caption-worker.ts — P5-5 (media shape: vision captions)
//
// The per-org drain that turns queued images into caption chunks. Pure
// orchestration over the P5-1..P5-4 modules + indexDocument, so the route
// (app/api/worker/caption) is a thin QStash-auth wrapper and this logic is
// unit-tested in isolation.
//
// Per row: inherit parent context → fetch bytes → classify (decorative/animated/
// oversized/unsupported skip) → org-wide SHA dedup → EXIF strip → vision caption
// → index the caption chunk (inheriting parent visibility) → mark the row. Every
// outcome is terminal-or-retried and telemetried — no image is ever silently
// dropped (audit D12): un-fetchable/decorative → skip-with-reason; model failure
// → a placeholder caption chunk + sync_skips. Budget overflow → deferred (kept,
// retried next drain). Dormant unless MEDIA_CAPTIONS is on.
//
// SERVICE-ROLE JUSTIFICATION: runs in the QStash-verified caption worker; the
// sync_skips write is org-scoped by explicit org_id, mirroring indexing.ts.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { qstash } from '@/lib/qstash/client'
import { MEDIA_CAPTIONS } from '@/lib/config/feature-flags'
import {
  claimPendingBatch,
  reclaimStaleProcessing,
  findCaptionBySha,
  captionsUsedToday,
  markDone,
  markDeferred,
  markSkipped,
  markFailed,
  bumpAttemptAndRequeue,
  DAILY_CAPTION_CAP,
  type MediaQueueRow,
} from './media-queue'
import { resolveParentContext, resolveMediaBytes, type ParentContext } from './media-bytes'
import { sha256, classifyMedia, stripExif } from './media-prep'
import {
  captionImage,
  buildCaptionChunk,
  captionKindForOrigin,
  mimeForFormat,
} from './vision-caption'
import { indexDocument } from './indexing'

export const CAPTION_BATCH = 10

export interface DrainSummary {
  claimed: number
  captioned: number
  deduped: number
  skipped: number
  failed: number
  deferred: number
  requeued: number
}

const zero = (): DrainSummary => ({
  claimed: 0, captioned: 0, deduped: 0, skipped: 0, failed: 0, deferred: 0, requeued: 0,
})

/** Stable, retry-idempotent chunk id for an image (same row → same id → upsert). */
function captionChunkId(row: MediaQueueRow, sha?: string): string {
  const suffix = (sha ?? row.bytes_ref ?? row.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)
  return `media:${row.source_doc_id}:${suffix}`
}

/** D12: record a skip in sync_skips (admin sync-health) in addition to the queue row. */
async function writeSyncSkip(
  orgId: string, connectionId: string, externalId: string, title: string, reason: string,
): Promise<void> {
  const { error } = await supabaseAdmin.from('sync_skips').upsert(
    {
      org_id: orgId,
      connection_id: connectionId,
      external_id: externalId,
      title: title.slice(0, 200),
      reason: reason.slice(0, 200),
      last_seen: new Date().toISOString(),
    },
    { onConflict: 'org_id,connection_id,external_id,reason' },
  )
  if (error) logger.warn({ externalId, err: error.message }, '[caption-worker] sync_skip write failed (non-fatal)')
}

/** Index a caption chunk (caption may be null → placeholder) inheriting parent context. */
async function indexCaption(
  row: MediaQueueRow, ctx: ParentContext, caption: string | null, sha?: string,
): Promise<void> {
  const chunk = buildCaptionChunk({
    chunkId: captionChunkId(row, sha),
    caption,
    breadcrumb: ctx.breadcrumb,
    sourceUrl: ctx.sourceUrl,
    provider: ctx.provider,
    sourceDocId: row.source_doc_id,
    origin: row.origin,
    sha256: sha,
  })
  await indexDocument(chunk, row.org_id, ctx.connectionId, ctx.departmentId, ctx.visibility, ctx.ownerUserId)
}

/**
 * Drain one org's media queue (one batch). Returns a per-outcome summary.
 * Never throws — per-row errors are isolated; a row left mid-flight stays
 * 'processing' and is reclaimed as stale on a later drain.
 */
export async function runCaptionDrain(orgId: string, limit: number = CAPTION_BATCH): Promise<DrainSummary> {
  const summary = zero()
  if (!MEDIA_CAPTIONS || !orgId) return summary

  await reclaimStaleProcessing(orgId)

  // Budget: count once, decrement locally as we caption (matches captionsUsedToday).
  let remaining = DAILY_CAPTION_CAP - (await captionsUsedToday(orgId))
  if (remaining <= 0) return summary // out of budget today — leave rows pending

  const rows = await claimPendingBatch(orgId, limit)
  summary.claimed = rows.length

  for (const row of rows) {
    try {
      if (remaining <= 0) {
        await markDeferred(row.id, orgId)
        summary.deferred++
        continue
      }

      // 1. Inherit parent context (connection, visibility, breadcrumb). A missing
      // parent is usually a race (stub enqueued just before the doc indexed) → retry.
      const ctx = await resolveParentContext(orgId, row.source_doc_id)
      if (!ctx) {
        if (await bumpAttemptAndRequeue(row)) summary.requeued++
        else { await markSkipped(row.id, orgId, 'parent_missing'); summary.skipped++ }
        continue
      }

      // 2. Resolve bytes for the origin.
      const resolved = await resolveMediaBytes(row, ctx)
      if (!resolved.ok) {
        if (resolved.transient) {
          // Transient (network/API) — retry; on exhaustion emit a placeholder.
          if (await bumpAttemptAndRequeue(row)) { summary.requeued++; continue }
          await indexCaption(row, ctx, null)
          await markFailed(row.id, orgId, resolved.reason)
          await writeSyncSkip(orgId, ctx.connectionId, captionChunkId(row), ctx.title, resolved.reason)
          summary.failed++
        } else {
          // Recognized un-fetchable (docling provenance ref / unimplemented origin).
          await markSkipped(row.id, orgId, resolved.reason)
          await writeSyncSkip(orgId, ctx.connectionId, captionChunkId(row), ctx.title, resolved.reason)
          summary.skipped++
        }
        continue
      }

      // 3. Classify (decorative / animated / oversized / unsupported skip).
      const bytes = resolved.bytes
      const decision = classifyMedia(bytes)
      if (decision.action === 'skip') {
        await markSkipped(row.id, orgId, decision.reason)
        await writeSyncSkip(orgId, ctx.connectionId, captionChunkId(row), ctx.title, decision.reason)
        summary.skipped++
        continue
      }

      // 4. Org-wide SHA dedup → reuse a prior caption; else caption (EXIF-stripped).
      const sha = sha256(bytes)
      let caption = await findCaptionBySha(orgId, sha)
      const deduped = caption !== null
      if (!deduped) {
        const cleaned = stripExif(bytes, decision.format)
        caption = await captionImage(
          cleaned, mimeForFormat(decision.format), captionKindForOrigin(row.origin), orgId,
        )
      }

      // 5. Index the caption chunk (placeholder when caption is null) + mark the row.
      await indexCaption(row, ctx, caption, sha)
      if (caption) {
        await markDone(row.id, orgId, sha, caption)
        remaining--
        if (deduped) summary.deduped++
        else summary.captioned++
      } else {
        await markFailed(row.id, orgId, 'caption_failed')
        await writeSyncSkip(orgId, ctx.connectionId, captionChunkId(row, sha), ctx.title, 'caption_failed')
        summary.failed++
      }
    } catch (err) {
      logger.warn(
        { rowId: row.id, origin: row.origin, err: err instanceof Error ? err.message : String(err) },
        '[caption-worker] row failed (left for stale reclaim)',
      )
    }
  }

  return summary
}

/**
 * Enqueue a caption drain for an org (deduped per org so a sync that writes many
 * stubs collapses to one in-flight drain). No-op when the flag is off or the app
 * url is unset. Fire-and-forget; never blocks the caller.
 */
export function enqueueCaptionDrain(orgId: string): void {
  if (!MEDIA_CAPTIONS || !orgId) return
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    logger.warn({ orgId }, '[caption-worker] NEXT_PUBLIC_APP_URL not set — cannot enqueue caption drain')
    return
  }
  qstash.publishJSON({
    url: `${appUrl}/api/worker/caption`,
    body: { org_id: orgId },
    retries: 3,
    deduplicationId: `org:caption-drain:${orgId}`,
  }).catch((err) => logger.warn(
    { orgId, err: err instanceof Error ? err.message : String(err) },
    '[caption-worker] failed to enqueue caption drain (non-fatal)',
  ))
}
