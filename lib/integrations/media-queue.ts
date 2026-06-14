// ============================================================
// lib/integrations/media-queue.ts — P5-3 (media shape: vision captions)
//
// Queue operations for the P5 caption worker over the `media_queue` table
// (schema created in P3: org_id, source_doc_id, sha256, origin, bytes_ref,
// caption, status, attempts, skip_reason). Stubs are written 'pending' during
// sync; this module claims them, dedupes by content SHA (org-wide repeated-logo
// skip), enforces the per-org daily caption budget, and records terminal states.
//
// SERVICE-ROLE JUSTIFICATION: the caption worker runs in a QStash-verified
// background context (no end-user request / RLS session). Every query is scoped
// by an explicit org_id column, and media_queue's RLS is admin-read only — the
// worker writes via the service role exactly like embed-retry. No content is
// stored or logged here (bytes_ref is a pointer, never bytes).
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export type MediaStatus = 'pending' | 'processing' | 'done' | 'deferred' | 'failed' | 'skipped'

export interface MediaQueueRow {
  id: string
  org_id: string
  source_doc_id: string
  sha256: string | null
  origin: string
  bytes_ref: string | null
  caption: string | null
  status: MediaStatus
  attempts: number
}

const SELECT_COLS = 'id, org_id, source_doc_id, sha256, origin, bytes_ref, caption, status, attempts'

/** Per-org images captioned per UTC day. Overflow stays queued (status 'deferred'). */
export const DAILY_CAPTION_CAP = 500

/** Max delivery attempts before a row is terminally failed (placeholder emitted). */
export const MAX_ATTEMPTS = 3

/** Processing rows older than this are treated as crashed and reclaimed. */
const STALE_PROCESSING_MS = 15 * 60 * 1000

// ── Claiming ─────────────────────────────────────────────────────────────────

/**
 * Atomically claim up to `limit` queued images for this org: flip
 * pending/deferred → processing and return the claimed rows. The status guard on
 * the UPDATE makes concurrent drains race-safe — only the worker that flips a row
 * gets it back. Deferred rows (yesterday's budget overflow) are re-eligible.
 */
export async function claimPendingBatch(orgId: string, limit: number): Promise<MediaQueueRow[]> {
  // 1. Pick candidate ids (oldest first).
  const { data: candidates, error: selErr } = await supabaseAdmin
    .from('media_queue')
    .select('id')
    .eq('org_id', orgId)
    .in('status', ['pending', 'deferred'])
    .order('created_at', { ascending: true })
    .limit(limit)
  if (selErr) {
    logger.warn({ orgId, err: selErr.message }, '[media-queue] claim select failed')
    return []
  }
  const ids = (candidates ?? []).map((r) => (r as { id: string }).id)
  if (ids.length === 0) return []

  // 2. Flip to processing, guarded on still-claimable status (race-safe).
  const { data: claimed, error: updErr } = await supabaseAdmin
    .from('media_queue')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .in('id', ids)
    .in('status', ['pending', 'deferred'])
    .select(SELECT_COLS)
  if (updErr) {
    logger.warn({ orgId, err: updErr.message }, '[media-queue] claim update failed')
    return []
  }
  return (claimed ?? []) as MediaQueueRow[]
}

/**
 * Reset processing rows that have been stuck longer than STALE_PROCESSING_MS
 * (worker crashed mid-batch) back to pending so they are retried. Returns the
 * count reclaimed. Best-effort; failures are logged and swallowed.
 */
export async function reclaimStaleProcessing(orgId: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS).toISOString()
  const { data, error } = await supabaseAdmin
    .from('media_queue')
    .update({ status: 'pending', updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('status', 'processing')
    .lt('updated_at', cutoff)
    .select('id')
  if (error) {
    logger.warn({ orgId, err: error.message }, '[media-queue] reclaim stale failed (non-fatal)')
    return 0
  }
  return (data ?? []).length
}

// ── Dedup + budget ───────────────────────────────────────────────────────────

/**
 * Org-wide caption dedup: if this exact image (by content SHA) was already
 * captioned for the org, return that caption so a repeated logo/asset is not
 * re-sent to the model. Returns null on miss.
 */
export async function findCaptionBySha(orgId: string, sha256: string): Promise<string | null> {
  if (!sha256) return null
  const { data, error } = await supabaseAdmin
    .from('media_queue')
    .select('caption')
    .eq('org_id', orgId)
    .eq('sha256', sha256)
    .eq('status', 'done')
    .not('caption', 'is', null)
    .limit(1)
    .maybeSingle()
  if (error) {
    logger.warn({ orgId, err: error.message }, '[media-queue] sha dedup lookup failed (non-fatal)')
    return null
  }
  const caption = (data as { caption?: string | null } | null)?.caption
  return caption && caption.trim() ? caption : null
}

/** Images captioned (status 'done') for this org since 00:00 UTC today. */
export async function captionsUsedToday(orgId: string): Promise<number> {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  const { count, error } = await supabaseAdmin
    .from('media_queue')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'done')
    .gte('updated_at', start.toISOString())
  if (error) {
    logger.warn({ orgId, err: error.message }, '[media-queue] budget count failed (assuming 0)')
    return 0
  }
  return count ?? 0
}

/** True when the org still has caption budget left for today. */
export async function hasBudgetRemaining(orgId: string): Promise<boolean> {
  return (await captionsUsedToday(orgId)) < DAILY_CAPTION_CAP
}

// ── Terminal / transition writes ─────────────────────────────────────────────

async function patchRow(id: string, orgId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin
    .from('media_queue')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
  if (error) {
    logger.warn({ id, err: error.message }, '[media-queue] row update failed (non-fatal)')
  }
}

/** Captioned successfully — store the caption + sha for dedup, status 'done'. */
export function markDone(id: string, orgId: string, sha256: string | null, caption: string): Promise<void> {
  return patchRow(id, orgId, { status: 'done', caption, sha256 })
}

/** Budget exhausted — keep queued for the next drain (never dropped). */
export function markDeferred(id: string, orgId: string): Promise<void> {
  return patchRow(id, orgId, { status: 'deferred' })
}

/** Recognized non-captionable image (decorative/animated/format) — skip with reason. */
export function markSkipped(id: string, orgId: string, reason: string): Promise<void> {
  return patchRow(id, orgId, { status: 'skipped', skip_reason: reason.slice(0, 200) })
}

/** Terminal failure after retries — placeholder chunk is emitted by the worker. */
export function markFailed(id: string, orgId: string, reason: string): Promise<void> {
  return patchRow(id, orgId, { status: 'failed', skip_reason: reason.slice(0, 200) })
}

/**
 * Transient failure (e.g. byte fetch error): bump attempts and either re-queue
 * (status 'pending') or, once MAX_ATTEMPTS is reached, give up. Returns true when
 * the row was re-queued, false when it has exhausted its retries (caller should
 * then markFailed + emit the placeholder).
 */
export async function bumpAttemptAndRequeue(row: MediaQueueRow): Promise<boolean> {
  const attempts = (row.attempts ?? 0) + 1
  if (attempts >= MAX_ATTEMPTS) {
    await patchRow(row.id, row.org_id, { attempts })
    return false
  }
  await patchRow(row.id, row.org_id, { status: 'pending', attempts })
  return true
}

/**
 * Distinct org ids that currently have claimable (pending/deferred) media. The
 * cron drains each; bounded by `limit` so one tick can't fan out unbounded.
 */
export async function listOrgsWithQueuedMedia(limit = 200): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('media_queue')
    .select('org_id')
    .in('status', ['pending', 'deferred'])
    .limit(5000)
  if (error) {
    logger.warn({ err: error.message }, '[media-queue] listOrgsWithQueuedMedia failed')
    return []
  }
  const seen = new Set<string>()
  for (const r of (data ?? []) as Array<{ org_id: string }>) {
    seen.add(r.org_id)
    if (seen.size >= limit) break
  }
  return [...seen]
}

/** Admin sync-health surface: queue depth by status for an org. */
export async function queueDepth(orgId: string): Promise<Record<MediaStatus, number>> {
  const out: Record<MediaStatus, number> = {
    pending: 0, processing: 0, done: 0, deferred: 0, failed: 0, skipped: 0,
  }
  const { data, error } = await supabaseAdmin
    .from('media_queue')
    .select('status')
    .eq('org_id', orgId)
  if (error) {
    logger.warn({ orgId, err: error.message }, '[media-queue] queueDepth failed')
    return out
  }
  for (const r of (data ?? []) as Array<{ status: MediaStatus }>) {
    if (r.status in out) out[r.status]++
  }
  return out
}
