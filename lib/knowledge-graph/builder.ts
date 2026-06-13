// ============================================================
// knowledge-graph/builder.ts — Graph builder (ATH-60)
//
// Triggered after every indexing batch by the graph-build worker.
// For each document: loads chunks from document_embeddings, runs
// the entity extractor (ATH-58), then upserts nodes/edges (ATH-59).
//
// SHA-256 content-hash dedup: if a document's content_hash hasn't
// changed since the last extraction we skip it entirely.
//
// Runs asynchronously via QStash so it never blocks the main
// indexing flow (ATH-44 wires this in after index-delta completes).
// ============================================================

import { createHash } from 'node:crypto'
// SERVICE-ROLE JUSTIFICATION: KG build runs as a QStash background job after
// indexing — no user RLS context exists. Reads are confined to documents /
// document_embeddings as extraction input; user-facing reads live in query.ts
// under withRLS().
import { supabaseAdmin } from '@/lib/supabase/server'
import { extractEntitiesAndRelations } from './extractor'
import { shouldRunExtractionChained } from './extraction-gate'
import { buildStructuredLinkGraph } from './structured-links'
import { buildStructuredOwnerGraph } from './structured-owners'
import { buildStructuredRecordGraph } from './structured-records'
import { buildSchemaEntityGraph, TABULAR_RESOURCE_TYPES } from '@/lib/integrations/bi-chunking'
import { KG_OWNER_GRAPH, TABULAR_TIER_C, KG_CRM_EDGES } from '@/lib/config/feature-flags'
import { upsertGraph, deleteByDocument } from './storage'
import { detectCommunities } from './community'
import { extractAndUpsertEvents } from './event-extractor'
import { readChunkText, hasFullChunkText } from '@/lib/indexing/chunk-text-store'
import type { RLSContext } from '@/lib/supabase/rls-client'
import { logger } from '@/lib/logger'


// ---- Types --------------------------------------------------

export type BuildMode = 'incremental' | 'full'

export interface BuildResult {
  processedDocs: number
  skippedDocs: number
  totalNodes: number
  totalEdges: number
  errors: string[]
  remainingDocs: string[] // ATH-60: for recursive re-enqueuing
  /** Chunks that fell back to content_preview (< 500 chars) because chunk_text was absent.
   * A high ratio indicates documents need re-indexing to populate the chunk_text column. */
  shortTextChunks: number
}


// ---- Core builder -------------------------------------------

/**
 * Build or update the knowledge graph for the given documents.
 *
 * @param orgId       - The organization to build for.
 * @param documentIds - Specific document IDs to process (incremental).
 *                      Pass empty array for full rebuild (caller must set mode='full').
 * @param mode        - 'incremental' processes only given IDs;
 *                      'full' queries all doc IDs for the org.
 */
export async function buildGraphForDocuments(
  orgId: string,
  documentIds: string[],
  mode: BuildMode = 'incremental',
): Promise<BuildResult> {
  const result: BuildResult = {
    processedDocs: 0,
    skippedDocs: 0,
    totalNodes: 0,
    totalEdges: 0,
    errors: [],
    remainingDocs: [],
    shortTextChunks: 0,
  }


  // ── Resolve the full list of docs to process ──────────────
  let docIds = documentIds

  if (mode === 'full') {
    const { data: allDocs, error } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('org_id', orgId)

    docIds = (allDocs ?? []).map((d: { id: string }) => d.id)
  }

  // ATH-60 safety: limit document count per job to prevent timeout (Serverless limit)
  // We process 20 docs and re-enqueue the rest.
  const BATCH_SIZE = 20
  if (docIds.length > BATCH_SIZE) {
    result.remainingDocs = docIds.slice(BATCH_SIZE)
    docIds = docIds.slice(0, BATCH_SIZE)
    logger.info({ orgId, currentBatch: docIds.length, remaining: result.remainingDocs.length }, "[builder] Large batch detected; splitting for recursive processing")
  }

  if (docIds.length === 0) return result

  // ── Process each document ─────────────────────────────────
  for (const docId of docIds) {
    try {
      const processed = await processDocument(orgId, docId, result)
      if (processed) result.processedDocs++
      else result.skippedDocs++
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ orgId, docId, err: msg }, "[builder] Error processing document")
      result.errors.push(`${docId}: ${msg}`)
    }
  }

  // ── Community detection pass ──────────────────────────────
  // After all docs processed in the current batch, assign community IDs.
  // NOTE: We only run this if no more docs are remaining to process for the whole job.
  if (result.processedDocs > 0 && result.remainingDocs.length === 0) {
    try {
      await detectCommunities(orgId)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ orgId, err: msg }, "[builder] Community detection failed")
      // We don't block the extraction result, but we log the error for ATH-61
      result.errors.push(`community: ${msg}`)
    }
  }


  return result
}

// ---- Per-document processing --------------------------------

async function processDocument(
  orgId: string,
  docId: string,
  result: BuildResult,
): Promise<boolean> {
  // 1. Load the document metadata for content_hash dedup check
  const { data: doc, error: docErr } = await supabaseAdmin
    .from('documents')
    .select('id, org_id, connection_id, external_id, source_type, content_hash, last_extracted_hash, department_id, visibility, title, metadata')
    .eq('id', docId)
    .eq('org_id', orgId)
    .single()

  if (docErr || !doc) {
    throw new Error(`Document not found: ${docId}`)
  }

  // 2. SHA-256 skip: if content_hash unchanged since last extraction, skip
  if (doc.content_hash && doc.last_extracted_hash === doc.content_hash) {
    return false // skipped
  }

  // 3. Read stored chunk text from document_embeddings (zero-copy design).
  // chunk_text is persisted in metadata->>'chunk_text' at index time, so we
  // never need to re-fetch from the live source — which would fail whenever the
  // provider connection is down, rate-limited, or the token has expired.
  const { data: embRows, error: embErr } = await supabaseAdmin
    .from('document_embeddings')
    .select('chunk_index, content_preview, metadata')
    .eq('document_id', docId)
    .order('chunk_index', { ascending: true })

  if (embErr) {
    throw new Error(`Failed to load embeddings for document ${docId}: ${embErr.message}`)
  }
  if (!embRows?.length) {
    throw new Error(`No indexed chunks found for document ${docId}. Document must be indexed before KG extraction.`)
  }

  // Check if at least one chunk has usable text.  When all chunks are empty we
  // can't extract anything useful — warn and skip rather than throw, so a single
  // un-indexed document doesn't abort the rest of the batch.
  const hasText = embRows.some((row: any) => readChunkText(row) !== null)
  if (!hasText) {
    logger.warn(
      { orgId, docId },
      "[builder] All chunks have empty text — skipping KG extraction. Re-index this document to populate chunk_text."
    )
    return false // treated as skipped, not an error
  }

  // 4. Build RLS context for storage writes
  const ctx: RLSContext = {
    org_id: orgId,
    user_id: 'system',
    user_role: 'admin',
  }

  // 5. Delete existing graph contributions from this document before re-extraction
  await deleteByDocument(ctx, docId)

  // 6. Run entity/relation extraction.
  // Use the stored sub-chunks from document_embeddings directly — no re-chunking.
  // Re-chunking with a different strategy would misalign KG citations with vector search results.
  let docShortTextChunks = 0
  const extractorChunks = embRows
    .map((row: any, idx: number) => {
      const text = readChunkText(row) ?? ''
      if (!text) return null
      // Track chunks where chunk_text was absent and we fell back to content_preview.
      // content_preview is capped at 200 chars, so these are always "short".
      if (!hasFullChunkText(row)) docShortTextChunks++
      return {
        text,
        chunk_index: row.chunk_index ?? idx,
        org_id: orgId,
        document_id: docId,
        department_id: doc.department_id ?? undefined,
        visibility: (doc.visibility ?? 'department') as any,
        metadata: { ...(row.metadata ?? {}), source_type: doc.source_type },
      }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)

  result.shortTextChunks += docShortTextChunks

  // Warn when most chunks are short-text fallbacks — signals the whole document
  // needs re-indexing to get full chunk_text into metadata.
  if (extractorChunks.length > 0 && docShortTextChunks / extractorChunks.length > 0.5) {
    logger.warn(
      { orgId, docId, shortTextChunks: docShortTextChunks, totalChunks: extractorChunks.length },
      "[builder] >50% of chunks used content_preview fallback — re-index this document for better KG quality"
    )
  }

  // P4-1 (D2): a document whose chunks are ALL deterministic tabular chunks
  // (stats/sample/agg) is Tier C — it gets schema entities with ZERO LLM calls,
  // never the entity/relation LLM over statistical text. Flag-gated.
  const isTabularDoc =
    TABULAR_TIER_C &&
    extractorChunks.length > 0 &&
    extractorChunks.every((c) =>
      TABULAR_RESOURCE_TYPES.has(String((c.metadata as Record<string, unknown> | undefined)?.resource_type ?? '')))

  // P4-6 (D3): a doc whose chunks are ALL marked skip_extraction (cancelled /
  // self-declined calendar events) is indexed for history but never LLM-extracted.
  const isSkipExtractionDoc =
    extractorChunks.length > 0 &&
    extractorChunks.every((c) => (c.metadata as Record<string, unknown> | undefined)?.skip_extraction === true)

  // Tier A/B gate (REFOCUS §5.3 + P2-10 chain): Slack chunks get embeddings
  // only unless they match decision/blocker signal patterns AND GLiNER
  // confirms real person/org/project entities (sidecar down → fail open).
  const chunkTexts = extractorChunks.map((c) => c.text)
  const runLLM =
    !isTabularDoc &&
    !isSkipExtractionDoc &&
    (await shouldRunExtractionChained(doc.source_type, chunkTexts))
  if (isTabularDoc) {
    logger.info({ docId, sourceType: doc.source_type }, '[builder] Tier C (tabular) — deterministic schema entities, no LLM')
  } else if (isSkipExtractionDoc) {
    logger.info({ docId, sourceType: doc.source_type }, '[builder] skip_extraction (cancelled/declined) — indexed, no LLM')
  } else if (!runLLM) {
    logger.info({ docId, sourceType: doc.source_type }, '[builder] Tier B — gate not passed, skipping LLM extraction')
  }

  const { nodes, edges } = runLLM
    ? await extractEntitiesAndRelations(extractorChunks, supabaseAdmin)
    : { nodes: [], edges: [] }

  const docArg = {
    id: doc.id,
    org_id: doc.org_id,
    title: doc.title ?? null,
    department_id: doc.department_id ?? null,
    visibility: doc.visibility ?? null,
    metadata: (doc.metadata ?? null) as Record<string, unknown> | null,
  }

  // Structured links (REFOCUS §5.3): Jira/Linear/GitHub blocking links — no LLM.
  const structured = buildStructuredLinkGraph(docArg)
  nodes.push(...structured.nodes)
  edges.push(...structured.edges)

  // Structured owners (P2-3): PERSON → work_item edges from fetcher-provided
  // owner annotations. Behind KG_OWNER_GRAPH (P2 rollback story) — default OFF
  // until the phase gate.
  if (KG_OWNER_GRAPH) {
    const ownersGraph = buildStructuredOwnerGraph(docArg)
    nodes.push(...ownersGraph.nodes)
    edges.push(...ownersGraph.edges)
  }

  // CRM field edges (P4-7): deterministic owner→OWNS + record→TIED_TO_ACCOUNT
  // from CRM record annotations — no LLM. Behind KG_CRM_EDGES (P4 rollback).
  // Reads doc.metadata.structured_owners / structured_account.
  if (KG_CRM_EDGES) {
    const recordGraph = buildStructuredRecordGraph(docArg)
    nodes.push(...recordGraph.nodes)
    edges.push(...recordGraph.edges)
  }

  // Schema entities (P4-1 / D2): deterministic service/metric/dimension nodes
  // from tabular stats chunks — no LLM. Behind TABULAR_TIER_C (P4 rollback
  // story). Additive + idempotent (node/edge dedup), so safe even on mixed docs.
  if (TABULAR_TIER_C) {
    const schemaGraph = buildSchemaEntityGraph(
      extractorChunks,
      orgId,
      doc.department_id ?? null,
      (doc.visibility ?? 'department') as Parameters<typeof buildSchemaEntityGraph>[3],
      docId,
    )
    nodes.push(...schemaGraph.nodes)
    edges.push(...schemaGraph.edges)
  }

  // BUG-12 FIX: Only update global counters after full success
  if (nodes.length > 0 || edges.length > 0) {
    // 7. Upsert nodes then edges in one session.
    // upsertGraph shares a single withRLS connection for both writes.
    // If edges fail after nodes succeed we run a compensating deleteByDocument
    // so the next extraction run starts from a clean slate for this document.
    let nodeIdMap: Map<string, string> = new Map()
    try {
      nodeIdMap = await upsertGraph(ctx, nodes, edges)
    } catch (upsertErr: any) {
      logger.error(
        { err: upsertErr.message, docId, orgId },
        "[builder] upsertGraph failed — compensating rollback via deleteByDocument"
      )
      // Best-effort cleanup: remove any orphaned nodes written before the failure
      await deleteByDocument(ctx, docId).catch((rollbackErr: any) =>
        logger.error(
          { err: rollbackErr.message, docId, orgId },
          "[builder] compensating rollback also failed — graph may have orphaned nodes; will self-heal on next extraction"
        )
      )
      throw upsertErr
    }

    result.totalNodes += nodes.length
    result.totalEdges += edges.length

    // 7b. Event extraction — fire-and-forget; never blocks the build job
    extractAndUpsertEvents(extractorChunks, orgId, docId, nodeIdMap).catch((err: any) =>
      logger.warn({ err: err?.message, docId }, "[builder] Event extraction failed")
    )
  }

  // 8. Mark document as extracted
  // BUG-15 FIX: Skip if content_hash is null to avoid disabling dedup permanently
  if (doc.content_hash) {
    await markExtracted(orgId, docId, doc.content_hash)
  }

  return true
}

// ---- Hash stamp ---------------------------------------------

async function markExtracted(
  org_id: string,
  doc_id: string,
  content_hash: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('documents')
    .update({ last_extracted_hash: content_hash })
    .eq('id', doc_id)
    .eq('org_id', org_id)

  if (error) {
    throw new Error(`Failed to mark extracted: ${error.message}`)
  }
}

