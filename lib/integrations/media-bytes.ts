// ============================================================
// lib/integrations/media-bytes.ts — P5-4 (media shape: vision captions)
//
// Two resolution steps the caption worker needs before it can caption + index a
// queued image:
//
//   1. resolveParentContext(orgId, sourceDocId) — read the parent `documents`
//      row so the caption chunk INHERITS the parent's connection, department,
//      visibility, owner, and breadcrumb. This closes two cross-phase gaps:
//        · media_queue carries no connection_id (P3 stub) — we get it here;
//        · "private-channel files inherit source visibility" (P5 edge protocol)
//          — enforced by inheriting the parent row's visibility, never widening.
//
//   2. resolveMediaBytes(row, ctx) — fetch the actual image bytes for the row's
//      origin. Implemented concretely for Gmail attachments (revives the dormant
//      fetchGmailAttachment, playbook P5-1). Other origins are recognized with an
//      explicit, telemetried skip reason rather than a silent drop (audit D12):
//        · docling_picture — the P3 stub stored a PROVENANCE ref ("file.pdf:pic1",
//          no bytes; the sidecar deliberately returns no image data). Captioning
//          PDF figures needs the sidecar to emit a fetchable image handle — a
//          documented sidecar follow-up. Until then these are skipped, not failed.
//        · notion_image / slack_file / drive_image / onedrive_image — per-connector
//          authenticated byte fetch is a tracked follow-up; the dispatch map makes
//          each a one-function addition.
//
// SERVICE-ROLE JUSTIFICATION: runs in the QStash-verified caption worker (no RLS
// session). The documents read is scoped by explicit org_id; no content is logged.
// ============================================================

import 'server-only'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { fetchGmailAttachment } from './google/gmail-fetcher'
import type { MediaQueueRow } from './media-queue'

// Mirrors the row-visibility union in indexing.ts (no shared export today). The
// caption chunk inherits the parent document's visibility verbatim and passes it
// straight to indexDocument — never widening access.
export type VisibilityLevel =
  | 'org_wide' | 'department' | 'bi_accessible' | 'confidential' | 'restricted'

export interface ParentContext {
  documentId: string
  connectionId: string
  departmentId: string | null
  ownerUserId: string | null
  visibility: VisibilityLevel
  provider: string
  title: string
  sourceUrl: string
  /** Human-readable location for the `[Image in {breadcrumb}]` prefix. */
  breadcrumb: string
}

/**
 * Load the parent document context for a queued image. Returns null when the
 * parent row is gone (the image must NOT be indexed without an authoritative
 * visibility to inherit). Best-effort on errors → null.
 */
export async function resolveParentContext(
  orgId: string,
  sourceDocId: string,
): Promise<ParentContext | null> {
  const { data, error } = await supabaseAdmin
    .from('documents')
    .select('id, connection_id, department_id, owner_user_id, visibility, source_type, title, external_url, metadata, context_summary')
    .eq('org_id', orgId)
    .eq('external_id', sourceDocId)
    .limit(1)
    .maybeSingle()
  if (error) {
    logger.warn({ orgId, err: error.message }, '[media-bytes] parent context read failed')
    return null
  }
  if (!data || !data.connection_id) return null

  const meta = (data.metadata ?? {}) as Record<string, unknown>
  const title = (data.title as string) || sourceDocId
  const folder =
    (typeof meta.folder_path === 'string' && meta.folder_path) ||
    (typeof meta.breadcrumb_path === 'string' && meta.breadcrumb_path) ||
    ''
  const breadcrumb = folder ? `${folder} › ${title}` : title

  return {
    documentId: data.id as string,
    connectionId: data.connection_id as string,
    departmentId: (data.department_id as string) ?? null,
    ownerUserId: (data.owner_user_id as string) ?? null,
    visibility: (data.visibility as VisibilityLevel) ?? 'department',
    provider: (data.source_type as string) ?? 'unknown',
    title,
    sourceUrl: (data.external_url as string) || '',
    breadcrumb,
  }
}

// ── Byte resolution ──────────────────────────────────────────────────────────

export type ResolveResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: ResolveSkipReason; transient: boolean }

export type ResolveSkipReason =
  | 'missing_bytes_ref'
  | 'bad_source_ref'
  | 'no_parent_connection'
  | 'provenance_ref_unfetchable'   // docling_picture — needs sidecar image handle
  | 'origin_fetch_unimplemented'   // notion/slack/drive/onedrive — tracked follow-up
  | 'fetch_error'                  // transient network/API failure → retry

/** `gmail:{messageId}` → messageId; null when the ref is malformed. */
export function parseGmailMessageId(sourceDocId: string): string | null {
  const m = /^gmail:([^:]+)/.exec(sourceDocId)
  return m ? m[1] : null
}

/** Fetch image bytes for a Gmail attachment row (revives fetchGmailAttachment). */
async function resolveGmailAttachment(
  row: MediaQueueRow,
  ctx: ParentContext,
): Promise<ResolveResult> {
  const messageId = parseGmailMessageId(row.source_doc_id)
  if (!messageId) return { ok: false, reason: 'bad_source_ref', transient: false }
  if (!row.bytes_ref) return { ok: false, reason: 'missing_bytes_ref', transient: false }
  try {
    const bytes = await fetchGmailAttachment(ctx.connectionId, row.org_id, messageId, row.bytes_ref)
    return { ok: true, bytes }
  } catch (err) {
    logger.warn(
      { origin: row.origin, err: err instanceof Error ? err.message : String(err) },
      '[media-bytes] gmail attachment fetch failed (will retry)',
    )
    return { ok: false, reason: 'fetch_error', transient: true }
  }
}

/**
 * Origins whose byte fetch is a tracked follow-up. Recognized (not a silent
 * drop) — the worker records the reason and skips. Adding real support is a
 * single resolver function + a map entry.
 */
const DEFERRED_ORIGINS: Record<string, ResolveSkipReason> = {
  docling_picture: 'provenance_ref_unfetchable',
  notion_image: 'origin_fetch_unimplemented',
  slack_file: 'origin_fetch_unimplemented',
  drive_image: 'origin_fetch_unimplemented',
  onedrive_image: 'origin_fetch_unimplemented',
}

/**
 * Resolve image bytes for a queued media row. The origin dispatch keeps each
 * source isolated; an unknown origin is treated as a recognized
 * unimplemented-fetch skip (never a hard failure).
 */
export async function resolveMediaBytes(
  row: MediaQueueRow,
  ctx: ParentContext,
): Promise<ResolveResult> {
  if (!ctx.connectionId) return { ok: false, reason: 'no_parent_connection', transient: false }

  if (row.origin === 'gmail_attachment') {
    return resolveGmailAttachment(row, ctx)
  }

  const deferred = DEFERRED_ORIGINS[row.origin]
  return { ok: false, reason: deferred ?? 'origin_fetch_unimplemented', transient: false }
}
