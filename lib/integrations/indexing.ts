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
import type { FetchedChunk } from './base'
import { logger } from '@/lib/logger'
import { embedBatchDetailed, type EmbeddingHint } from '@/lib/ai/embedding-factory'
import { chunk as tokenChunk } from '@/lib/langgraph/tools/chunker'
import { writeChunkText } from '@/lib/indexing/chunk-text-store'

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
function normalizeContent(content: string): string {
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
 * Routes to the correct chunker based on source type.
 *
 * Strategy | Trigger                         | Chunk size
 * ---------|-------------------------------- |-----------
 * record   | CRM + calendar                  | no split (whole record)
 * tabular  | data warehouse + BI             | 768 tok / 96 overlap
 * thread   | Slack, tickets, issues, PRs     | 768 tok / 128 overlap
 * email    | gmail, outlook                  | 2000 char / 200 overlap
 * document | everything else (default)       | 512 tok / 64 overlap
 */
function chunkContent(content: string, sourceType?: string): string[] {
  if (!sourceType) {
    return tokenChunk(content, { chunkSize: 512, overlap: 64 }).map((c) => c.text)
  }

  // Structured records: each record is its own semantic unit — no splitting
  if (RECORD_SOURCE_TYPES.has(sourceType)) {
    if (content.length <= 3000) return [content]
    // Oversized record (unusual): fall back to email chunker which breaks on sentence boundaries
    return chunkEmail(content)
  }

  // Tabular/BI: fetchers already structure content; keep large chunks to preserve column context
  if (TABULAR_SOURCE_TYPES.has(sourceType)) {
    if (content.length <= 4000) return [content]
    return tokenChunk(content, { chunkSize: 768, overlap: 96 }).map((c) => c.text)
  }

  // Conversational threads: larger chunks + more overlap to keep thread context intact
  if (THREAD_SOURCE_TYPES.has(sourceType)) {
    return tokenChunk(content, { chunkSize: 768, overlap: 128 }).map((c) => c.text)
  }

  // Email: character-based (short bodies, no tokenizer overhead needed)
  if (EMAIL_SOURCE_TYPES.has(sourceType)) {
    return chunkEmail(content)
  }

  // Long-form documents: Drive, Confluence, Notion pages, wiki — 512-token default
  return tokenChunk(content, { chunkSize: 512, overlap: 64 }).map((c) => c.text)
}

// ---- Embedding Generation ---------------------------------------

/**
 * Generates embeddings for the given texts via the EmbeddingFactory.
 * Provider resolved from: org BYOK → system env.
 * Hint lets the Google/Jina providers select the optimal task type.
 * Returns the model id alongside the vectors so rows carry provenance (P0-3).
 */
async function generateEmbeddings(
  texts: string[],
  orgId?: string,
  hint?: EmbeddingHint
): Promise<{ embeddings: number[][]; model: string }> {
  const { embeddings, model } = await embedBatchDetailed(texts, orgId, hint)
  return { embeddings, model }
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

/** Resolve the embedding hint from source type (only relevant for Google provider). */
function resolveEmbeddingHint(sourceType?: string): EmbeddingHint {
  if (sourceType && RECORD_SOURCE_TYPES.has(sourceType)) return 'structured'
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

  // 1. Normalize then split content into type-appropriate chunks
  const normalizedContent = normalizeContentTracked(chunk.content, chunk.title)
  const contentChunks = chunkContent(normalizedContent, chunk.metadata.provider)

  if (contentChunks.length === 0) return documentId

  // 2. Generate embeddings for all chunks in a single batch (org-BYOK aware)
  const { embeddings, model: embeddingModel } = await generateEmbeddings(
    contentChunks, orgId, resolveEmbeddingHint(chunk.metadata.provider as string)
  )

  // 3. Build the records to upsert — must match document_embeddings schema exactly
  const structuredFields = RECORD_SOURCE_TYPES.has(chunk.metadata.provider as string)
    ? extractStructuredFields(chunk.metadata)
    : null

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
      embedding: embeddings[index],
      embedding_model: embeddingModel,
      pipeline_version: PIPELINE_VERSION,
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
      if (!contentChanged) {
        // Content hash unchanged — embeddings are still valid, skip re-embedding
        prepared.push({ chunk, documentId, subChunks: [] })
        continue
      }
      const subChunks = chunkContent(normalizeContentTracked(chunk.content, chunk.title), chunk.metadata.provider)
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
    const structuredFields = RECORD_SOURCE_TYPES.has(item.chunk.metadata.provider as string)
      ? extractStructuredFields(item.chunk.metadata)
      : null
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
    const hint = resolveEmbeddingHint(item.chunk.metadata.provider as string)
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

  // ---- Phase 4: upsert all records in one call -------------------
  const records = allTemplates
    .map((tmpl, idx) => ({
      ...tmpl,
      embedding: allEmbeddings[idx] ?? [],
      embedding_model: allModels[idx],
      pipeline_version: PIPELINE_VERSION,
    }))
    .filter((r) => r.embedding.length > 0)

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

