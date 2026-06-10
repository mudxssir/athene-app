// ============================================================
// indexer.ts — Zero-storage embedding + KG pipeline (ATH-28)
//
// The core guarantee: document body text arrives as an argument,
// passes through chunker + embedder + extractor in memory, and
// only vectors, hashes, and extracted entities/edges ever touch
// Supabase. The body is never persisted.
//
// Wire-up:
//   ATH-28 (this file) runs the pipeline.
//   ATH-58 extractor.extractEntitiesAndRelations(chunks) → graph data.
//   ATH-59 storage.upsertNodes/upsertEdges persists the graph.
//
//   Rule #2 Protection: The indexer uses an explicit field allow-list
//   for all Supabase writes to ensure ephemeral body text never leaks.
// ============================================================

import { createHash } from "node:crypto";
// SERVICE-ROLE JUSTIFICATION: indexing is a background write path that runs
// at ingest time before any user RLS context exists (embeddings, chunk counts,
// document locks). No user-facing reads are served from this module.
import { supabaseAdmin } from "@/lib/supabase/server";
import type { RLSContext } from "@/lib/supabase/rls-client";
import {
  extractEntitiesAndRelations,
} from "@/lib/knowledge-graph/extractor";
import { shouldRunExtraction } from "@/lib/knowledge-graph/extraction-gate";
import { deleteByDocument, upsertEdges, upsertNodes } from "@/lib/knowledge-graph/storage";
import type { ExtractorChunk, Visibility } from "@/lib/knowledge-graph/types";
import { chunk as chunkText, countTokens } from "./chunker";
import { embed, EMBEDDING_CONFIG } from "./embedder";
import { logger } from "@/lib/logger";
import { incrementIndexedDocCount } from "@/lib/telemetry/metrics";

export type IndexDocumentInput = {
  orgId: string;
  /** FK to documents.id — document row MUST exist before calling. */
  documentId: string;
  deptId?: string | null;
  sourceType: string;
  /** Ephemeral document body. Not stored. */
  content: string;
  visibility: Visibility;
  ownerUserId?: string | null;
  /** Passed through to document_embeddings.metadata — caller must not include body. */
  metadata?: Record<string, unknown>;
  /** When true, also build knowledge graph entries. Default true. */
  buildGraph?: boolean;
  /**
   * RLS context for graph writes. Required when buildGraph !== false.
   * Embedding writes go through supabaseAdmin (no user context at index time).
   */
  rlsContext?: RLSContext;
};

export type IndexDocumentResult = {
  chunksTotal: number;
  chunksEmbedded: number;
  chunksSkippedByHash: number;
  nodesUpserted: number;
  edgesUpserted: number;
};

/**
 * Index a document end-to-end. Idempotent — rerunning on the same
 * content short-circuits per-chunk via content_hash dedup.
 */
export async function indexDocument(
  input: IndexDocumentInput
): Promise<IndexDocumentResult> {
  const {
    orgId,
    documentId,
    deptId = null,
    sourceType,
    content,
    visibility,
    ownerUserId = null,
    metadata = {},
    buildGraph = true,
    rlsContext,
  } = input;

  if (!orgId) throw new Error("orgId is required");
  if (!documentId) throw new Error("documentId is required");
  if (typeof content !== "string" || content.length === 0) {
    return emptyResult();
  }
  // Fail-fast if caller passed the body into metadata
  assertNoContentInMetadata(metadata);

  // ---- 0. Acquire Lock (V-04 Fix) ----------------------------
  // Prevents race conditions during concurrent indexing
  const { data: locked, error: lockErr } = await supabaseAdmin.rpc("acquire_document_lock", {
    p_document_id: documentId,
  });

  if (lockErr || !locked) {
    logger.warn({ documentId }, "[indexer] Could not acquire lock for document - another job may be running");
    // We don't throw here to avoid failing the whole worker, but we skip graph pass
  }

  try {

  // ---- 1. Chunk in RAM --------------------------------------
  const chunks = chunkText(content);
  if (chunks.length === 0) return emptyResult();

  // ---- 2. Compute per-chunk SHA-256 -------------------------
  const hashes = chunks.map((c) => sha256(c.text));

  // ---- 3. Dedup against existing embeddings for this doc ----
  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("document_embeddings")
    .select("content_hash")
    .eq("org_id", orgId)
    .eq("document_id", documentId);
  if (fetchErr) throw new Error(`dedup fetch failed: ${fetchErr.message}`);

  const existingHashes = new Set<string>(
    (existing ?? []).map((r: { content_hash: string | null }) => r.content_hash ?? "")
  );

  const newChunkIndices: number[] = [];
  const newTexts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!existingHashes.has(hashes[i])) {
      newChunkIndices.push(i);
      newTexts.push(chunks[i].text);
    }
  }

  // ---- 4. Embed only new chunks -----------------------------
  let vectors: number[][] = [];
  if (newTexts.length > 0) {
    vectors = await embed(newTexts);
    if (vectors.length !== newTexts.length) {
      throw new Error(
        `embed returned ${vectors.length} vectors for ${newTexts.length} inputs`
      );
    }
  }

  // ---- 5. Upsert vector + metadata rows (NEVER content) ----
  if (newTexts.length > 0) {
    // BUG-01 FIX: Strict field allow-list to prevent text leaks
    const rows = newChunkIndices.map((chunkIdx, i) => {
      const row = {
        org_id: orgId,
        document_id: documentId,
        chunk_index: chunks[chunkIdx].chunk_index,
        content_hash: hashes[chunkIdx],
        embedding: vectors[i],
        department_id: deptId,
        owner_user_id: ownerUserId,
        visibility,
        source_type: sourceType,
        token_count: countTokens(chunks[chunkIdx].text),
        metadata,
      };

      // Rule #2: Explicitly pick only allowed keys
      return pick(row, [
        "org_id",
        "document_id",
        "chunk_index",
        "content_hash",
        "embedding",
        "department_id",
        "owner_user_id",
        "visibility",
        "source_type",
        "token_count",
        "metadata",
      ]);
    });

    const { error: upsertErr } = await supabaseAdmin
      .from("document_embeddings")
      .upsert(rows, { onConflict: "document_id,chunk_index" });
    if (upsertErr) throw new Error(`embeddings upsert failed: ${upsertErr.message}`);
  }

  // ---- 6. Update documents.chunk_count / last_indexed_at ---
  {
    const { error } = await supabaseAdmin
      .from("documents")
      .update({
        chunk_count: chunks.length,
        last_indexed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId);
    if (error) {
      // Non-fatal — the embeddings are correct even if this fails
      logger.warn({ err: error.message, documentId }, "[indexer] documents update failed");
    }
  }

  // ---- 7. Knowledge Graph pass (ATH-58 / ATH-59) ------------
  let nodesUpserted = 0;
  let edgesUpserted = 0;
  if (buildGraph && chunks.length > 0) {
    if (!rlsContext) {
      logger.warn({ documentId }, "[indexer] buildGraph requested but no rlsContext provided — skipping KG");
    } else if (!shouldRunExtraction(sourceType, chunks.map((c) => c.text))) {
      // Tier A/B gate (REFOCUS §5.3): Tier B sources (Slack) get embeddings
      // only unless a decision/blocker signal pattern matches — no LLM call.
      logger.info({ documentId, sourceType }, "[indexer] Tier B — no signal match, skipping KG extraction");
    } else {
      const extractorChunks: ExtractorChunk[] = chunks.map((c) => ({
        text: c.text,
        chunk_index: c.chunk_index,
        org_id: orgId,
        document_id: documentId,
        department_id: deptId,
        visibility,
      }));

      // BUG-02 FIX: Wrap KG pass in try/catch and ensure awaits
      try {
        const { nodes, edges } = await extractEntitiesAndRelations(extractorChunks, supabaseAdmin);

        if (nodes.length > 0) {
          const idMap = await upsertNodes(rlsContext, nodes);
          nodesUpserted = nodes.length;
          if (edges.length > 0) {
            await upsertEdges(rlsContext, edges, idMap);
            edgesUpserted = edges.length;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, documentId }, "[indexer] Knowledge Graph pass failed");
        // Propagate error to QStash job if this is a critical failure
        throw new Error(`KG pass failed: ${msg}`);
        }
      }
    }

  // ---- 7a. Metrics (only on full success) ------------------
  incrementIndexedDocCount({ integrationType: sourceType, orgId });

  return {
    chunksTotal: chunks.length,
    chunksEmbedded: newTexts.length,
    chunksSkippedByHash: chunks.length - newTexts.length,
    nodesUpserted,
    edgesUpserted,
  };
  } finally {
    // ---- 9. Release Lock -------------------------------------
    if (locked) {
      await supabaseAdmin.rpc("release_document_lock", {
        p_document_id: documentId,
      });
    }
  }
}

/**
 * Reindex: clean up prior graph contributions from this document
 * then run indexDocument again. Embeddings are content-hashed so
 * unchanged chunks skip the embed call.
 */
export async function reindexDocument(
  input: IndexDocumentInput
): Promise<IndexDocumentResult> {
  if (input.rlsContext && input.buildGraph !== false) {
    await deleteByDocument(input.rlsContext, input.documentId);
  }
  return indexDocument(input);
}

// ---- Internals ------------------------------------------------

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function emptyResult(): IndexDocumentResult {
  return {
    chunksTotal: 0,
    chunksEmbedded: 0,
    chunksSkippedByHash: 0,
    nodesUpserted: 0,
    edgesUpserted: 0,
  };
}

/** Utility to pick specific keys from an object */
function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

/**
 * Defensive check: the metadata jsonb column is free-form, which
 * means a lazy caller could smuggle body text into it. Reject any
 * key that looks like content.
 */
function assertNoContentInMetadata(metadata: any, path = "metadata"): void {
  if (!metadata || typeof metadata !== "object") return;

  const forbidden = ["content", "body", "text", "raw", "html", "markdown", "plaintext"];

  for (const [key, value] of Object.entries(metadata)) {
    const currentPath = `${path}.${key}`;
    if (forbidden.includes(key.toLowerCase())) {
      throw new Error(
        `Rule #2 violation: metadata key "${currentPath}" is reserved — document body must not be persisted`
      );
    }
    if (value && typeof value === "object") {
      assertNoContentInMetadata(value, currentPath);
    }
  }
}

export const INDEXER_CONFIG = {
  embeddingModel: EMBEDDING_CONFIG.model,
  embeddingDimensions: EMBEDDING_CONFIG.dimensions,
} as const;
