// ============================================================
// integrations/indexing.ts — Bridge between fetchers and vector store
//
// Takes FetchedChunk[] from any provider, chunks large content,
// generates embeddings via OpenAI, and upserts into Supabase
// document_embeddings table using the service-role client.
//
// Writes go through supabaseAdmin (service-role) — bypasses RLS.
// Reads later go through withRLS() — the existing pattern.
//
// No tokens or raw content is logged. Only document metadata
// is written to the database.
// ============================================================

import { createHash } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase/server'
import type { FetchedChunk, DataShape } from './base'
import { isSkipSentinel } from './base'
import { logger } from '@/lib/logger'
import { embedBatchDetailed, embedBatchLateChunking, embedBatchPinned, type EmbeddingHint } from '@/lib/ai/embedding-factory'
import { chunk as tokenChunk } from '@/lib/langgraph/tools/chunker'
import { writeChunkText } from '@/lib/indexing/chunk-text-store'
import { PIPELINE_SHAPE_ROUTING } from '@/lib/config/feature-flags'
import { computeSignals, selectStrategy, MIN_TOKENS, MAX_CHUNKS_PER_DOC } from '@/lib/indexing/chunk-policy'
import { splitByHeadings, splitFenceAtomic, groupIntoParents } from '@/lib/indexing/structural-chunker'
import { qstash } from '@/lib/qstash/client'

// ---- Constants --------------------------------------------------

/**
 * Pipeline version stamped on every embedding row (P0-3). Bump whenever a
 * shape's chunking policy changes — the reindex worker finds rows below the
 * current version and re-chunks/re-embeds them.
 */
export const PIPELINE_VERSION = 1

/** Email sources use character-based chunking (body text is short, no tokenizer needed) */
const EMAIL_CHUNK_SIZE_CHARS = 2000
const EMAIL_CHUNK_OVERLAP_CHARS = 200

/** Email source_type values that bypass the token-based chunker */
const EMAIL_SOURCE_TYPES = new Set(['gmail', 'outlook', 'email'])

/**
 * Structured record types (CRM, calendar) — each record is its own semantic unit.
 * Avoid sub-chunking: a deal record fragmented across two chunks loses field relationships.
 */
const RECORD_SOURCE_TYPES = new Set([
  'hubspot', 'salesforce',
  'google_calendar', 'ms_calendar',
])

/**
 * Tabular / BI types — fetchers pre-structure content (stats / sample / aggregation).
 * Use larger chunks to keep column headers with data rows.
 */
const TABULAR_SOURCE_TYPES = new Set([
  'snowflake', 'bigquery', 'redshift',
  'looker', 'metabase', 'tableau', 'dbt', 'powerbi',
  'direct_upload_tabular', 'google_sheets',
  'google_drive_tabular', 'onedrive_tabular', 'sharepoint_tabular',
])

/**
 * Conversational thread types — use larger chunks + more overlap to preserve
 * thread context across multiple messages.
 */
const THREAD_SOURCE_TYPES = new Set([
  'slack', 'zendesk', 'jira', 'linear', 'github',
])

/**
 * P1-9: shapes where Jina late chunking improves quality.
 * Children of the same document are batched in one API call with late_chunking:true
 * so each child's embedding is conditioned on the full sibling context.
 */
const LATE_CHUNKING_SHAPES = new Set<DataShape>(['prose', 'email', 'thread', 'work_item'])

/** CRM / structured field keys worth promoting to filterable metadata */
const STRUCTURED_FIELD_KEYS = [
  'stage', 'amount', 'priority', 'status', 'lifecycle',
  'industry', 'pipeline', 'close_date', 'severity',
  'type', 'probability', 'owner_id', 'email', 'company',
]

// ---- Content Chunking -------------------------------------------

/**
 * Character-based chunker for email content.
 * Tries to break at sentence boundaries when possible.
 */
function chunkEmail(content: string): string[] {
  if (content.length <= EMAIL_CHUNK_SIZE_CHARS) {
    return [content]
  }

  const chunks: string[] = []
  let start = 0

  while (start < content.length) {
    let end = start + EMAIL_CHUNK_SIZE_CHARS

    if (end < content.length) {
      const searchWindow = content.substring(Math.max(start, end - 200), end)
      const lastSentenceEnd = Math.max(
        searchWindow.lastIndexOf('. '),
        searchWindow.lastIndexOf('.\n'),
        searchWindow.lastIndexOf('? '),
        searchWindow.lastIndexOf('! ')
      )
      if (lastSentenceEnd > 0) {
        end = Math.max(start, end - 200) + lastSentenceEnd + 1
      }
    }

    chunks.push(content.substring(start, Math.min(end, content.length)).trim())
    start = end - EMAIL_CHUNK_OVERLAP_CHARS
    if (start >= content.length) break
  }

  return chunks.filter((c) => c.length > 0)
}

/**
 * Strips residual HTML and normalizes whitespace before chunking.
 * Most fetchers already clean their output, but some sources (Confluence,
 * Zendesk, Gmail) can leak partial tags.
 *
 * HTML detection heuristic: only strip a `<...>` span if it looks like an
 * actual tag (starts with a letter or `/`). This avoids corrupting code/SQL
 * content where `<`, `>` appear as comparison operators (e.g. `WHERE age < 30`).
 */
export function normalizeContent(content: string): string {
  return content
    .replace(/<\/?\s*[a-zA-Z][^>]*>/g, ' ')  // strip HTML tags (letter-prefixed only)
    .replace(/&(?:amp|lt|gt|quot|nbsp|apos);/gi, (m) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': ' ', '&apos;': "'"
    } as Record<string, string>)[m.toLowerCase()] ?? m)  // decode common entities
    .replace(/\n{3,}/g, '\n\n')     // collapse runs of blank lines
    .replace(/ {2,}/g, ' ')         // collapse multiple spaces
    .trim()
}

/**
 * Extracts well-known structured fields from chunk metadata into a
 * dedicated key for future faceted search (no schema migration required).
 */
function extractStructuredFields(meta: Record<string, unknown>): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {}
  for (const key of STRUCTURED_FIELD_KEYS) {
    if (meta[key] !== undefined) fields[key] = meta[key]
  }
  return Object.keys(fields).length > 0 ? fields : null
}

/**
 * Routes to the correct chunker based on DataShape and the dynamic chunk-policy
 * engine (P1-5/P1-6) when PIPELINE_SHAPE_ROUTING is on.
 *
 * Policy engine dispatch (flag ON):
 *   computeSignals → selectStrategy → execute plan:
 *     passthrough   — whole content as single chunk (below noSplitCeiling)
 *     structural    — markdown heading-tree splitting with breadcrumb trails
 *     fence-atomic  — token windows, code fences treated as atomic units
 *     token         — fixed-window token chunker with plan's budget and overlap
 *
 * Legacy fallback (flag OFF or shape absent):
 *   Provider-string dispatch retained from P1-3; logs [indexing] legacy-routing.
 */
export function chunkContent(content: string, shape?: DataShape, legacyProvider?: string): string[] {
  if (PIPELINE_SHAPE_ROUTING && shape) {
    const signals = computeSignals(content)
    const plan = selectStrategy(shape, signals)

    switch (plan.strategy) {
      case 'passthrough':
        return [content]

      case 'structural': {
        const sections = splitByHeadings(content, MIN_TOKENS)
        return sections.map(c => c.text).slice(0, MAX_CHUNKS_PER_DOC)
      }

      case 'fence-atomic': {
        const overlapTokens = Math.round(plan.childTarget * plan.overlap)
        const overlapFraction = plan.childTarget > 0 ? overlapTokens / plan.childTarget : 0
        return splitFenceAtomic(content, plan.childTarget, overlapFraction)
          .map(c => c.text)
          .slice(0, MAX_CHUNKS_PER_DOC)
      }

      case 'token':
      default: {
        const overlapTokens = Math.round(plan.childTarget * plan.overlap)
        return tokenChunk(content, { chunkSize: plan.childTarget, overlap: overlapTokens })
          .map(c => c.text)
          .slice(0, MAX_CHUNKS_PER_DOC)
      }
    }
  }

  // Legacy provider-string routing (flag off or no shape on chunk)
  if (legacyProvider) {
    logger.warn({ provider: legacyProvider }, '[indexing] legacy-routing')
  }
  if (!legacyProvider) {
    return tokenChunk(content, { chunkSize: 512, overlap: 64 }).map((c) => c.text)
  }

  // Structured records: each record is its own semantic unit — no splitting
  if (RECORD_SOURCE_TYPES.has(legacyProvider)) {
    if (content.length <= 3000) return [content]
    return chunkEmail(content)
  }

  // Tabular/BI: fetchers already structure content; keep large chunks to preserve column context
  if (TABULAR_SOURCE_TYPES.has(legacyProvider)) {
    if (content.length <= 4000) return [content]
    return tokenChunk(content, { chunkSize: 768, overlap: 96 }).map((c) => c.text)
  }

  // Conversational threads: larger chunks + more overlap to keep thread context intact
  if (THREAD_SOURCE_TYPES.has(legacyProvider)) {
    return tokenChunk(content, { chunkSize: 768, overlap: 128 }).map((c) => c.text)
  }

  // Email: character-based (short bodies, no tokenizer overhead needed)
  if (EMAIL_SOURCE_TYPES.has(legacyProvider)) {
    return chunkEmail(content)
  }

  // Long-form documents: Drive, Confluence, Notion pages, wiki — 512-token default
  return tokenChunk(content, { chunkSize: 512, overlap: 64 }).map((c) => c.text)
}

// ---- Embedding Generation ---------------------------------------

/**
 * Generates embeddings for the given texts via the EmbeddingFactory.
 *
 * P1-13 pinned path (PIPELINE_SHAPE_ROUTING ON + orgId present):
 *   Uses only the org's pinned model (embedBatchPinned). Throws if the pinned
 *   provider fails — caller is responsible for writing null-embedding rows and
 *   enqueueing embed-retry (no silent cross-model fallback).
 *
 * Legacy path (flag OFF or no orgId):
 *   Multi-provider fallback chain as before.
 */
async function generateEmbeddings(
  texts: string[],
  orgId?: string,
  hint?: EmbeddingHint,
  lateChunking = false,
): Promise<{ embeddings: number[][]; model: string }> {
  if (PIPELINE_SHAPE_ROUTING && orgId) {
    // Pinned path — throws on provider failure (no cross-model fallback)
    const { embeddings, model } = await embedBatchPinned(texts, orgId, hint, lateChunking)
    return { embeddings, model }
  }
  const fn = lateChunking ? embedBatchLateChunking : embedBatchDetailed
  const { embeddings, model } = await fn(texts, orgId, hint)
  return { embeddings, model }
}

/**
 * P1-13: enqueue an embed-retry job for a document whose rows were written with
 * needs_embedding=true (pinned provider unavailable). Idempotent per document
 * via QStash deduplicationId. Failures are logged and swallowed — the retry
 * queue is a recovery lane, never a reason to fail indexing.
 */
function enqueueEmbedRetry(orgId: string, documentId: string): void {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    logger.warn({ documentId }, '[indexing] NEXT_PUBLIC_APP_URL not set — cannot enqueue embed-retry')
    return
  }
  qstash.publishJSON({
    url: `${appUrl}/api/worker/embed-retry`,
    body: { org_id: orgId, document_id: documentId },
    retries: 3,
    deduplicationId: `org:embed-retry:${documentId}`,
  }).catch(err => logger.warn(
    { err: err instanceof Error ? err.message : String(err), documentId },
    '[indexing] Failed to enqueue embed-retry job (non-fatal)'
  ))
}

/**
 * normalizeContent wrapper that measures how much was stripped (P0-7 / audit D8
 * exposure metric): a high strip ratio on code-bearing docs signals corruption
 * by the HTML-strip regex — informs the P3 per-shape sanitization fix.
 */
function normalizeContentTracked(content: string, title?: string): string {
  const normalized = normalizeContent(content)
  if (content.length > 500 && normalized.length < content.length * 0.95) {
    logger.warn(
      {
        title: title ?? null,
        originalBytes: content.length,
        normalizedBytes: normalized.length,
        strippedRatio: Number((1 - normalized.length / content.length).toFixed(3)),
      },
      '[indexing] normalizeContent stripped >5% of document bytes'
    )
  }
  return normalized
}

/** Resolve the embedding hint from shape (flag on) or legacy provider string. */
export function resolveEmbeddingHint(shape?: DataShape, legacyProvider?: string): EmbeddingHint {
  if (PIPELINE_SHAPE_ROUTING && shape) return shape === 'record' ? 'structured' : 'document'
  if (legacyProvider && RECORD_SOURCE_TYPES.has(legacyProvider)) return 'structured'
  return 'document'
}

// ---- Document record resolution ---------------------------------

type VisibilityLevel = 'org_wide' | 'department' | 'bi_accessible' | 'confidential' | 'restricted'

/**
 * Upserts a row in the `documents` table for this chunk and returns its UUID.
 * Uses UNIQUE (org_id, connection_id, external_id) to make it idempotent.
 */
type UpsertDocumentResult = { documentId: string; contentChanged: boolean }

async function upsertDocumentRecord(
  chunk: FetchedChunk,
  orgId: string,
  connectionId: string,
  departmentId: string | null,
  visibility: VisibilityLevel,
  ownerUserId: string | null
): Promise<UpsertDocumentResult> {
  const newContentHash = createHash('sha256').update(chunk.content).digest('hex')

  // Check whether an identical version of this document is already indexed.
  // If the content_hash matches, skip re-embedding to avoid wasting API quota.
  const { data: existing } = await supabaseAdmin
    .from('documents')
    .select('id, content_hash')
    .eq('org_id', orgId)
    .eq('connection_id', connectionId)
    .eq('external_id', chunk.chunk_id)
    .maybeSingle()

  if (existing?.content_hash === newContentHash) {
    return { documentId: existing.id as string, contentChanged: false }
  }

  const { data, error } = await supabaseAdmin
    .from('documents')
    .upsert(
      {
        org_id: orgId,
        connection_id: connectionId,
        external_id: chunk.chunk_id,
        title: chunk.title,
        source_type: chunk.metadata.provider,
        department_id: departmentId,
        owner_user_id: ownerUserId,
        visibility,
        external_url: chunk.source_url,
        metadata: chunk.metadata,
        content_hash: newContentHash,
      },
      { onConflict: 'org_id,connection_id,external_id' }
    )
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`[indexing] Failed to upsert document record: ${error?.message}`)
  }
  return { documentId: data.id as string, contentChanged: true }
}

// ---- Skip-sentinel handling (P0-5, audit D11) --------------------

/**
 * Records a skipped-content event. Idempotent on
 * (org_id, connection_id, external_id, reason) — re-running a sync
 * refreshes last_seen instead of duplicating rows. Failures are
 * logged and swallowed: telemetry must never break indexing.
 */
async function recordSyncSkip(
  chunk: FetchedChunk,
  orgId: string,
  connectionId: string,
  reason: string
): Promise<void> {
  const { error } = await supabaseAdmin.from('sync_skips').upsert(
    {
      org_id: orgId,
      connection_id: connectionId,
      external_id: chunk.chunk_id,
      title: chunk.title,
      reason: reason.slice(0, 200),
      last_seen: new Date().toISOString(),
    },
    { onConflict: 'org_id,connection_id,external_id,reason' }
  )
  if (error) {
    logger.warn({ externalId: chunk.chunk_id, err: error.message }, '[indexing] Failed to record sync skip (non-fatal)')
  }
}

/**
 * Sentinel chunks keep their documents row (so delta-sync content-hash dedup
 * still works and the doc is flagged) but produce NO embeddings; any stale
 * embeddings from a previous real version are pruned.
 */
async function dropSentinelChunk(
  chunk: FetchedChunk,
  orgId: string,
  connectionId: string,
  documentId: string
): Promise<void> {
  await recordSyncSkip(chunk, orgId, connectionId, chunk.content.trim())

  // Flag the documents row so admin/debug surfaces can tell why it has no chunks
  const { error: flagErr } = await supabaseAdmin
    .from('documents')
    .update({ metadata: { ...chunk.metadata, skipped_reason: chunk.content.trim().slice(0, 200) } })
    .eq('id', documentId)
    .eq('org_id', orgId)
  if (flagErr) {
    logger.warn({ documentId, err: flagErr.message }, '[indexing] Failed to flag sentinel doc (non-fatal)')
  }

  const { error } = await supabaseAdmin
    .from('document_embeddings')
    .delete()
    .eq('document_id', documentId)
    .gte('chunk_index', 0)
  if (error) {
    logger.warn({ documentId, err: error.message }, '[indexing] Failed to prune sentinel doc embeddings (non-fatal)')
  }
}

// ---- Main Indexing Function -------------------------------------

/**
 * Indexes a single FetchedChunk into the vector store.
 *
 * Flow:
 *   1. Upsert the document metadata row (resolves/creates documents.id)
 *   2. Chunk the content if it exceeds CHUNK_SIZE_CHARS
 *   3. Generate embeddings for all chunks in a batch
 *   4. Upsert each chunk + embedding into document_embeddings
 *
 * @param chunk       - The fetched chunk to index
 * @param orgId       - Organization ID
 * @param connectionId - Nango connection UUID (links to connections.id)
 * @param departmentId - Department UUID for RLS scoping (nullable)
 * @param visibility  - Row-level visibility level
 * @param ownerUserId - org_members.id of the document owner (nullable)
 */
export async function indexDocument(
  chunk: FetchedChunk,
  orgId: string,
  connectionId: string,
  departmentId: string | null,
  visibility: VisibilityLevel = 'department',
  ownerUserId: string | null = null
): Promise<string> {
  // 0. Resolve/create the documents row; skip embedding if content unchanged
  const { documentId, contentChanged } = await upsertDocumentRecord(
    chunk, orgId, connectionId, departmentId, visibility, ownerUserId
  )
  if (!contentChanged) return documentId

  // 0b. Skip-sentinels: keep the doc row (flagged), write no embeddings (P0-5)
  if (isSkipSentinel(chunk.content)) {
    await dropSentinelChunk(chunk, orgId, connectionId, documentId)
    return documentId
  }

  // 1. Normalize then split content into type-appropriate chunks
  const normalizedContent = normalizeContentTracked(chunk.content, chunk.title)
  const isRecord = PIPELINE_SHAPE_ROUTING ? chunk.shape === 'record' : RECORD_SOURCE_TYPES.has(chunk.metadata.provider as string)
  const structuredFields = isRecord ? extractStructuredFields(chunk.metadata) : null
  const hint = resolveEmbeddingHint(chunk.shape, chunk.metadata.provider as string)

  // P1-8 + P1-9: structural strategy → parent rows (no embedding) + child rows (embedded,
  // with parent_chunk_index). Late chunking used for eligible shapes when Jina is active.
  if (PIPELINE_SHAPE_ROUTING && chunk.shape) {
    const signals = computeSignals(normalizedContent)
    const plan = selectStrategy(chunk.shape, signals)

    if (plan.strategy === 'structural' && plan.parentTarget !== null) {
      const sections = splitByHeadings(normalizedContent, MIN_TOKENS)
      if (sections.length === 0) return documentId

      const parentGroups = groupIntoParents(sections, plan.parentTarget)
      const records: object[] = []
      let nextChunkIndex = 0

      // Parent rows first (chunk_index 0..nParents-1); no embedding, just stored text.
      // needs_embedding stays false: parents are intentionally embedding-free and
      // must never be picked up by the embed-retry worker. Set explicitly so an
      // upsert over a previously-flagged row clears the flag (review fix #5).
      for (const group of parentGroups) {
        const parentIdx = nextChunkIndex++
        const meta = writeChunkText(chunk.metadata, group.parentText)
        if (structuredFields) (meta as Record<string, unknown>).structured_fields = structuredFields
        records.push({
          org_id: orgId,
          document_id: documentId,
          department_id: departmentId,
          owner_user_id: ownerUserId,
          source_type: chunk.metadata.provider,
          visibility,
          chunk_index: parentIdx,
          embedding: null,
          embedding_model: null,
          pipeline_version: PIPELINE_VERSION,
          parent_chunk_index: null,
          needs_embedding: false,
          content_hash: createHash('sha256').update(group.parentText).digest('hex'),
          content_preview: group.parentText.slice(0, 200),
          metadata: meta,
        })
      }

      // Child rows: embed with late chunking per parent group.
      // Review fix #2: a pinned-provider failure on any group must not throw the
      // whole document away — upsertDocumentRecord already stamped the new
      // content_hash, so a throw here means the doc is never retried. Instead,
      // the failed group's children are written as null-embedding placeholders
      // (needs_embedding=true) and an embed-retry job is enqueued after upsert.
      let anyChildNeedsRetry = false

      for (let gi = 0; gi < parentGroups.length; gi++) {
        const group = parentGroups[gi]
        const childTexts = group.children.map(c => c.text)
        const useLateChunking = LATE_CHUNKING_SHAPES.has(chunk.shape!) && childTexts.length > 1

        let childEmbeddings: number[][] = []
        let embeddingModel: string | null = null
        let groupNeedsRetry = false

        try {
          const result = await generateEmbeddings(childTexts, orgId, hint, useLateChunking)
          childEmbeddings = result.embeddings
          embeddingModel = result.model
        } catch (embErr) {
          logger.warn(
            { title: chunk.title, parentGroup: gi, err: embErr instanceof Error ? embErr.message : String(embErr) },
            '[indexing] Pinned provider failed on structural group — writing null-embedding placeholders, will enqueue embed-retry'
          )
          groupNeedsRetry = true
          anyChildNeedsRetry = true
        }

        for (let ci = 0; ci < childTexts.length; ci++) {
          const text = childTexts[ci]
          const childIdx = nextChunkIndex++
          const meta = writeChunkText(chunk.metadata, text)
          if (structuredFields) (meta as Record<string, unknown>).structured_fields = structuredFields
          records.push({
            org_id: orgId,
            document_id: documentId,
            department_id: departmentId,
            owner_user_id: ownerUserId,
            source_type: chunk.metadata.provider,
            visibility,
            chunk_index: childIdx,
            embedding: groupNeedsRetry ? null : childEmbeddings[ci],
            embedding_model: groupNeedsRetry ? null : embeddingModel,
            pipeline_version: PIPELINE_VERSION,
            parent_chunk_index: gi,  // points to parent row's chunk_index
            needs_embedding: groupNeedsRetry,
            content_hash: createHash('sha256').update(text).digest('hex'),
            content_preview: text.slice(0, 200),
            metadata: meta,
          })
        }
      }

      const { error } = await supabaseAdmin
        .from('document_embeddings')
        .upsert(records, { onConflict: 'document_id,chunk_index' })

      if (error) {
        logger.error({ title: chunk.title, err: error.message }, '[indexing] Error upserting structural chunks')
        throw error
      }

      if (anyChildNeedsRetry) {
        enqueueEmbedRetry(orgId, documentId)
      }

      const { error: pruneErr } = await supabaseAdmin
        .from('document_embeddings')
        .delete()
        .eq('document_id', documentId)
        .gte('chunk_index', nextChunkIndex)

      if (pruneErr) {
        logger.warn({ title: chunk.title, err: pruneErr.message }, '[indexing] Failed to prune stale structural chunks (non-fatal)')
      }

      return documentId
    }
  }

  // Standard (non-structural) path
  const contentChunks = chunkContent(normalizedContent, chunk.shape, chunk.metadata.provider as string)

  if (contentChunks.length === 0) return documentId

  // P1-9: use late chunking for eligible shapes when PIPELINE_SHAPE_ROUTING is on
  const useLateChunking = PIPELINE_SHAPE_ROUTING && !!chunk.shape && LATE_CHUNKING_SHAPES.has(chunk.shape) && contentChunks.length > 1

  // 2. Generate embeddings for all chunks in a single batch (org-BYOK aware)
  // P1-13: when PIPELINE_SHAPE_ROUTING is ON, generateEmbeddings uses the pinned model
  // and throws on provider failure (no cross-model fallback). We catch here and write
  // null-embedding placeholder rows so the document is not lost, then enqueue embed-retry.
  let embeddings: number[][] = []
  let embeddingModel = ''
  let needsRetry = false

  try {
    const result = await generateEmbeddings(contentChunks, orgId, hint, useLateChunking)
    embeddings = result.embeddings
    embeddingModel = result.model
  } catch (embErr) {
    if (PIPELINE_SHAPE_ROUTING && orgId) {
      // Write placeholder rows with needs_embedding=true; retry worker fills them in.
      logger.warn(
        { title: chunk.title, err: embErr instanceof Error ? embErr.message : String(embErr) },
        '[indexing] Pinned provider failed — writing null-embedding placeholders, enqueueing embed-retry'
      )
      needsRetry = true
      embeddings = contentChunks.map(() => [])
      embeddingModel = ''
    } else {
      throw embErr
    }
  }

  // 3. Build the records to upsert — must match document_embeddings schema exactly
  const records = contentChunks.map((text, index) => {
    const meta = writeChunkText(chunk.metadata, text)
    if (structuredFields) meta.structured_fields = structuredFields
    return {
      org_id: orgId,
      document_id: documentId,
      department_id: departmentId,
      owner_user_id: ownerUserId,
      source_type: chunk.metadata.provider,
      visibility,
      chunk_index: index,
      embedding: needsRetry ? null : (embeddings[index] ?? null),
      embedding_model: needsRetry ? null : (embeddingModel || null),
      pipeline_version: PIPELINE_VERSION,
      parent_chunk_index: null,
      needs_embedding: needsRetry,
      content_hash: createHash('sha256').update(text).digest('hex'),
      content_preview: text.slice(0, 200),
      metadata: meta,
    }
  })

  // 4. Upsert into Supabase via service-role (bypasses RLS)
  // onConflict matches UNIQUE (document_id, chunk_index) constraint
  const { error } = await supabaseAdmin
    .from('document_embeddings')
    .upsert(records, { onConflict: 'document_id,chunk_index' })

  if (error) {
    logger.error({ title: chunk.title, err: error.message }, '[indexing] Error upserting chunks')
    throw error
  }

  // P1-13: enqueue embed-retry job for placeholder rows
  if (needsRetry && orgId) {
    enqueueEmbedRetry(orgId, documentId)
  }

  // 5. Prune stale chunks — if the document shrank, delete high-index rows that are no longer valid.
  // e.g. doc went from 5 chunks → 3: delete chunk_index >= 3 so searches don't return stale content.
  const { error: pruneErr } = await supabaseAdmin
    .from('document_embeddings')
    .delete()
    .eq('document_id', documentId)
    .gte('chunk_index', contentChunks.length)

  if (pruneErr) {
    logger.warn({ title: chunk.title, err: pruneErr.message }, '[indexing] Failed to prune stale chunks (non-fatal)')
  }

  return documentId
}

/** Maximum texts per OpenAI embedding API call */
const EMBED_BATCH_SIZE = 96

/**
 * Indexes multiple FetchedChunks with batched embedding generation.
 *
 * Instead of one OpenAI call per document (N round-trips), this:
 *   1. Resolves/creates all document rows in parallel
 *   2. Splits every document's content into sub-chunks
 *   3. Sends all sub-chunk texts to OpenAI in batches of EMBED_BATCH_SIZE
 *   4. Upserts all embedding records in a single Supabase call
 */
export async function indexDocuments(
  chunks: FetchedChunk[],
  orgId: string,
  connectionId: string,
  departmentId: string | null,
  visibility: VisibilityLevel = 'department',
  ownerUserId: string | null = null
): Promise<{ indexed: number; errors: number; documentIds: string[] }> {
  if (chunks.length === 0) return { indexed: 0, errors: 0, documentIds: [] }

  // ---- Phase 1: resolve document rows in parallel -----------------
  type PreparedItem = {
    chunk: FetchedChunk
    documentId: string
    subChunks: string[]
  }

  const prepared: PreparedItem[] = []
  let errors = 0

  // ---- Phase 1: resolve document rows and split into sub-chunks ----
  for (const chunk of chunks) {
    try {
      const { documentId, contentChanged } = await upsertDocumentRecord(chunk, orgId, connectionId, departmentId, visibility, ownerUserId)
      if (contentChanged && isSkipSentinel(chunk.content)) {
        // Skip-sentinel: doc row kept, no embeddings, telemetry written (P0-5)
        await dropSentinelChunk(chunk, orgId, connectionId, documentId)
        prepared.push({ chunk, documentId, subChunks: [] })
        continue
      }
      if (!contentChanged) {
        // Content hash unchanged — embeddings are still valid, skip re-embedding
        prepared.push({ chunk, documentId, subChunks: [] })
        continue
      }
      const subChunks = chunkContent(normalizeContentTracked(chunk.content, chunk.title), chunk.shape, chunk.metadata.provider as string)
      if (subChunks.length > 0) {
        prepared.push({ chunk, documentId, subChunks })
      }
    } catch (err) {
      errors++
      logger.error(
        { title: chunk.title, err: err instanceof Error ? err.message : String(err) },
        '[indexing] Failed to prepare chunk'
      )
    }
  }

  // ---- Phase 2: flatten sub-chunk texts and build record templates -
  // Only include items with subChunks (items with empty subChunks had unchanged content)
  const changedItems = prepared.filter(item => item.subChunks.length > 0)
  const allTexts: string[] = changedItems.flatMap(item => item.subChunks)
  const allTemplates = changedItems.flatMap(item => {
    const isRecord = PIPELINE_SHAPE_ROUTING ? item.chunk.shape === 'record' : RECORD_SOURCE_TYPES.has(item.chunk.metadata.provider as string)
    const structuredFields = isRecord ? extractStructuredFields(item.chunk.metadata) : null
    return item.subChunks.map((text, index) => {
      const meta = writeChunkText(item.chunk.metadata, text)
      if (structuredFields) meta.structured_fields = structuredFields
      return {
        org_id: orgId,
        document_id: item.documentId,
        department_id: departmentId,
        owner_user_id: ownerUserId,
        source_type: item.chunk.metadata.provider,
        visibility,
        chunk_index: index,
        parent_chunk_index: null,  // P1-8: bulk path uses standalone rows (no parent grouping); structural docs use indexDocument
        content_hash: createHash('sha256').update(text).digest('hex'),
        content_preview: text.slice(0, 200),
        metadata: meta,
      }
    })
  })

  // ---- Phase 3: generate embeddings in batches (org-BYOK aware) ---
  // P0-4 (audit D9): one dispatch can mix shapes (e.g. Microsoft = email + calendar
  // + drive + tabular in a single array), so the hint is resolved per item and texts
  // are embedded in per-hint groups. Row alignment is preserved by flat index.
  const flatHints: EmbeddingHint[] = changedItems.flatMap(item => {
    const hint = resolveEmbeddingHint(item.chunk.shape, item.chunk.metadata.provider as string)
    return item.subChunks.map(() => hint)
  })

  const allEmbeddings: (number[] | null)[] = new Array(allTexts.length).fill(null)
  const allModels: (string | null)[] = new Array(allTexts.length).fill(null)

  const hintGroups = new Map<EmbeddingHint, number[]>()
  flatHints.forEach((hint, idx) => {
    const group = hintGroups.get(hint)
    if (group) group.push(idx)
    else hintGroups.set(hint, [idx])
  })

  for (const [hint, indices] of hintGroups) {
    for (let i = 0; i < indices.length; i += EMBED_BATCH_SIZE) {
      const batchIndices = indices.slice(i, i + EMBED_BATCH_SIZE)
      const batchTexts = batchIndices.map((idx) => allTexts[idx])
      try {
        const { embeddings, model } = await generateEmbeddings(batchTexts, orgId, hint)
        batchIndices.forEach((flatIdx, j) => {
          allEmbeddings[flatIdx] = embeddings[j]
          allModels[flatIdx] = model
        })
      } catch (err) {
        logger.error(
          { hint, batchStart: i, batchEnd: i + batchTexts.length, err: err instanceof Error ? err.message : String(err) },
          '[indexing] Embedding batch failed'
        )
        // Leave nulls so alignment is preserved; filtered out before upsert
        errors += batchTexts.length
      }
    }
  }

  // Review F5: per-hint groups embed independently, so a transient provider
  // failure can put two groups of ONE dispatch on different models. Rows carry
  // the model (P0-3) and search-side filtering lands with P1 pinning — until
  // then, make the mixed-space event loud at dispatch level too.
  const modelsUsed = new Set(allModels.filter((m): m is string => m !== null))
  if (modelsUsed.size > 1) {
    logger.warn(
      { orgId, models: [...modelsUsed], texts: allTexts.length },
      '[indexing] MIXED MODELS in one dispatch — affected docs are split across vector spaces until re-embedded'
    )
  }

  // ---- Phase 4: upsert all records in one call -------------------
  // Review fix #3: with pinning (flag ON) a failed batch must not silently drop
  // its rows — the documents row already carries the new content_hash, so the
  // next sync would skip them forever. Write null-embedding placeholders with
  // needs_embedding=true and enqueue embed-retry per affected document instead.
  // Flag OFF keeps the legacy behavior (failed rows filtered out, errors counted).
  const records = allTemplates
    .map((tmpl, idx) => {
      const embedded = allEmbeddings[idx] !== null
      return {
        ...tmpl,
        embedding: embedded ? allEmbeddings[idx] : null,
        embedding_model: embedded ? allModels[idx] : null,
        pipeline_version: PIPELINE_VERSION,
        needs_embedding: !embedded,
      }
    })
    .filter((r) => r.embedding !== null || PIPELINE_SHAPE_ROUTING)

  // Enqueue one embed-retry job per document that has placeholder rows
  if (PIPELINE_SHAPE_ROUTING) {
    const retryDocIds = new Set(
      records.filter(r => r.needs_embedding).map(r => r.document_id as string)
    )
    for (const docId of retryDocIds) {
      enqueueEmbedRetry(orgId, docId)
    }
  }

  if (records.length > 0) {
    const { error } = await supabaseAdmin
      .from('document_embeddings')
      .upsert(records, { onConflict: 'document_id,chunk_index' })

    if (error) {
      logger.error({ err: error.message }, '[indexing] Bulk upsert error')
      errors += records.length
      return { indexed: 0, errors, documentIds: [] }
    }

    // ---- Phase 5: prune stale chunks per document -------------------
    // Build documentId → highest new chunk_index so we can delete rows beyond it.
    // This handles documents that shrank (fewer chunks than before).
    const docToMaxChunk = new Map<string, number>()
    for (const r of records) {
      const cur = docToMaxChunk.get(r.document_id) ?? -1
      if (r.chunk_index > cur) docToMaxChunk.set(r.document_id, r.chunk_index)
    }
    for (const [docId, maxIdx] of docToMaxChunk) {
      const { error: pruneErr } = await supabaseAdmin
        .from('document_embeddings')
        .delete()
        .eq('document_id', docId)
        .gt('chunk_index', maxIdx)
      if (pruneErr) {
        logger.warn({ docId, err: pruneErr.message }, '[indexing] Failed to prune stale chunks (non-fatal)')
      }
    }
  }

  return {
    // Only count items that actually had new embeddings written — unchanged docs don't count.
    // This ensures graph-build is only enqueued when content actually changed,
    // and a Jina/API failure doesn't look like a successful sync.
    indexed: changedItems.length - errors,
    errors,
    documentIds: [...new Set(changedItems.map(p => p.documentId))]
  }
}

