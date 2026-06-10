// ============================================================
// storage.ts — kg_nodes / kg_edges write layer (ATH-59)
//
// Upsert logic matches the UNIQUE constraints on the two tables:
//   kg_nodes:  UNIQUE (org_id, label, entity_type)
//   kg_edges:  UNIQUE (org_id, source_node, target_node, relation)
//
// On conflict we MERGE array columns (department_ids,
// source_documents) rather than replace, and we upgrade
// provenance / confidence rather than overwrite.
//
// All writes run inside withRLS() so org isolation is enforced.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
import type { KGEdge, KGNode, KGProvenance } from "./types";
import { strongerProvenance, unionStrings, nodeKey, edgeKey } from "./utils";
import { logger } from "@/lib/logger";
import { embedBatch } from "@/lib/ai/embedder";
import { registerAlias } from "./entity-resolver";
import { KG_CONFIG } from "./config";

// ---- Node upsert ----------------------------------------------

/**
 * Upsert nodes into kg_nodes. For each incoming node:
 *  - If a node with the same (org_id, label, entity_type) already
 *    exists, merge department_ids and source_documents, upgrade
 *    visibility if needed, and fill in description if missing.
 *  - Otherwise insert a fresh row.
 *
 * Returns a map of (label::entity_type) → uuid so callers can
 * build the edge table from labels.
 */
export async function upsertNodes(
  ctx: RLSContext,
  nodes: KGNode[]
): Promise<Map<string, string>> {
  return withRLS(ctx, (supabase) => _upsertNodesWithClient(supabase, ctx, nodes));
}

async function _upsertNodesWithClient(
  supabase: SupabaseClient,
  ctx: RLSContext,
  nodes: KGNode[]
): Promise<Map<string, string>> {
    if (nodes.length === 0) return new Map();
    // 1. Fetch any existing rows for the incoming (label, entity_type) pairs
    const labels = Array.from(new Set(nodes.map((n) => n.label)));
    const { data: existingRows, error: fetchErr } = await supabase
      .from("kg_nodes")
      .select(
        "id, label, entity_type, department_ids, source_documents, visibility, description, metadata"
      )
      .eq("org_id", ctx.org_id)
      .in("label", labels);

    if (fetchErr) throw new Error(`kg_nodes fetch failed: ${fetchErr.message}`);

    const existingByKey = new Map<string, ExistingNode>();
    for (const row of (existingRows ?? []) as ExistingNode[]) {
      existingByKey.set(nodeKey(row.label, row.entity_type), row);
    }

    // 2. Batch document ownership validation (single round-trip instead of N)
    const allDocIds = Array.from(
      new Set(nodes.flatMap((n) => n.source_documents).filter(Boolean))
    );
    if (allDocIds.length > 0) {
      const { count, error: authErr } = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("org_id", ctx.org_id)
        .in("id", allDocIds);

      if (authErr || (count ?? 0) !== allDocIds.length) {
        throw new Error(
          `Unauthorized document access in node upsert: ${allDocIds.length} requested, ${count ?? 0} owned`
        );
      }
    }

    // 3. Split into update vs insert
    const toInsert: KGNode[] = [];
    const toUpdate: Array<{ id: string; patch: Partial<ExistingNode> }> = [];

    for (const n of nodes) {
      const key = nodeKey(n.label, n.entity_type);

      const existing = existingByKey.get(key);
      if (!existing) {
        toInsert.push(n);
        continue;
      }
      const mergedDeptIds = unionStrings(existing.department_ids ?? [], n.department_ids);
      const mergedDocs = unionStrings(existing.source_documents ?? [], n.source_documents);
      const mergedVisibility = maxVisibilityRaw(existing.visibility, n.visibility);
      const patch: Partial<ExistingNode> = {};

      if (!arraysEqual(existing.department_ids ?? [], mergedDeptIds)) {
        patch.department_ids = mergedDeptIds;
      }
      if (!arraysEqual(existing.source_documents ?? [], mergedDocs)) {
        patch.source_documents = mergedDocs;
      }
      if (existing.visibility !== mergedVisibility) {
        patch.visibility = mergedVisibility;
      }
      if (!existing.description && n.description) {
        patch.description = n.description;
      }

      if (Object.keys(patch).length > 0) {
        toUpdate.push({ id: existing.id, patch });
      }
    }

    // 3. Apply updates one-by-one (Supabase has no bulk-different-rows API)
    for (const { id, patch } of toUpdate) {
      const { error } = await supabase
        .from("kg_nodes")
        .update(patch)
        .eq("id", id)
        .eq("org_id", ctx.org_id);
      if (error) throw new Error(`kg_nodes update failed: ${error.message}`);
    }

    // 4. Bulk insert new rows (deduplicate within the batch first)
    let insertedRows: Array<{ id: string; label: string; entity_type: string }> = [];
    if (toInsert.length > 0) {
      const uniqueToInsert = new Map<string, any>();
      for (const n of toInsert) {
        const key = nodeKey(n.label, n.entity_type);
        if (!uniqueToInsert.has(key)) {
          uniqueToInsert.set(key, {
            org_id: n.org_id,
            label: n.label,
            entity_type: n.entity_type,
            department_ids: n.department_ids,
            visibility: n.visibility,
            source_documents: n.source_documents,
            description: n.description ?? null,
            metadata: n.metadata ?? {},
          });
        } else {
          // Merge within the batch
          const existing = uniqueToInsert.get(key);
          existing.department_ids = unionStrings(existing.department_ids, n.department_ids);
          existing.source_documents = unionStrings(existing.source_documents, n.source_documents);
          existing.visibility = maxVisibilityRaw(existing.visibility, n.visibility);
          if (!existing.description && n.description) existing.description = n.description;
        }
      }

      // ── Entity linking: embed new labels, find canonical root nodes ──────
      // Best-effort — failure just means the node is inserted without an
      // embedding and won't participate in dedup until next re-extraction.
      const insertArray = Array.from(uniqueToInsert.values());
      try {
        const labels = insertArray.map((n: any) => n.label as string);
        const embeddings = await embedBatch(labels, ctx.org_id);

        // Resolve canonical ID for each node in parallel
        const canonicalIds = await Promise.all(
          insertArray.map(async (node: any, i: number) => {
            try {
              const { data } = await supabase.rpc("find_canonical_node", {
                p_org_id: ctx.org_id,
                p_embedding: embeddings[i],
                p_entity_type: node.entity_type,
                p_threshold: KG_CONFIG.entity_resolution.merge_similarity_threshold,
              });
              return data ?? null;
            } catch {
              return null;
            }
          })
        );

        // Attach embedding and canonical_id to each insert row.
        // When a canonical is found, also register this label as an alias
        // so future lookups find it via the alias table (not just ilike).
        for (let i = 0; i < insertArray.length; i++) {
          insertArray[i].label_embedding = embeddings[i];
          insertArray[i].canonical_id = canonicalIds[i];
          if (canonicalIds[i]) {
            // Best-effort — registerAlias swallows its own errors
            registerAlias(
              ctx.org_id,
              canonicalIds[i],
              insertArray[i].label,
              "extraction",
              KG_CONFIG.entity_resolution.merge_similarity_threshold,
              embeddings[i]
            );
          }
        }
      } catch (embErr) {
        logger.warn(
          { orgId: ctx.org_id, err: embErr instanceof Error ? embErr.message : String(embErr) },
          "[storage] Entity linking embedding failed — inserting nodes without label_embedding"
        );
      }

      const { data, error } = await supabase
        .from("kg_nodes")
        .insert(insertArray)
        .select("id, label, entity_type");
      if (error) throw new Error(`kg_nodes insert failed: ${error.message}`);
      insertedRows = data ?? [];
    }

    // 5. Build the full label→id map (existing + inserted)
    const idMap = new Map<string, string>();
    for (const row of existingByKey.values()) {
      idMap.set(nodeKey(row.label, row.entity_type), row.id);
    }
    for (const row of insertedRows) {
      idMap.set(nodeKey(row.label, row.entity_type), row.id);
    }
    return idMap;
}

// ---- Edge upsert ----------------------------------------------

/**
 * Upsert edges into kg_edges. Requires a label→id map from
 * upsertNodes() so we can resolve source/target UUIDs. Edges whose
 * endpoints are missing from the map are silently skipped.
 *
 * Conflict policy:
 *   - provenance: never downgraded (EXTRACTED > INFERRED > AMBIGUOUS)
 *   - confidence: kept at GREATEST
 */
export async function upsertEdges(
  ctx: RLSContext,
  edges: KGEdge[],
  nodeIdMap: Map<string, string>
): Promise<void> {
  await withRLS(ctx, (supabase) => _upsertEdgesWithClient(supabase, ctx, edges, nodeIdMap));
}

async function _upsertEdgesWithClient(
  supabase: SupabaseClient,
  ctx: RLSContext,
  edges: KGEdge[],
  nodeIdMap: Map<string, string>
): Promise<void> {
    if (edges.length === 0) return;
    // Resolve label→id. Skip edges whose endpoints weren't upserted.
    type Resolved = {
      org_id: string;
      source_node: string;
      target_node: string;
      relation: string;
      provenance: KGProvenance;
      confidence: number;
      source_document: string | null;
      department_id: string | null;
      visibility: string;
      metadata: Record<string, unknown>;
    };

    const resolved: Resolved[] = [];
    for (const e of edges) {
      const sId = nodeIdMap.get(nodeKey(e.source_label, e.source_entity_type));
      const tId = nodeIdMap.get(nodeKey(e.target_label, e.target_entity_type));
      if (!sId || !tId) continue;
      resolved.push({
        org_id: e.org_id,
        source_node: sId,
        target_node: tId,
        relation: e.relation,
        provenance: e.provenance,
        confidence: e.confidence,
        source_document: e.source_document ?? null,
        department_id: e.department_id ?? null,
        visibility: e.visibility,
        metadata: e.metadata ?? {},
      });
    }
    if (resolved.length === 0) return;

    // Fetch existing edges that collide on the unique key
    const pairs = resolved.map((r) => ({
      source_node: r.source_node,
      target_node: r.target_node,
      relation: r.relation,
    }));
    // Collect all node IDs involved in any edge endpoint
    const allNodeIds = Array.from(
      new Set(pairs.flatMap((p) => [p.source_node, p.target_node]))
    );

    // Use OR filter: fetch edges where EITHER endpoint is in our set,
    // then JS-level dedup to find exact matches. AND filter misses edges
    // where only one endpoint is in the resolved set.
    const { data: existing, error: fetchErr } = await supabase
      .from("kg_edges")
      .select("id, source_node, target_node, relation, provenance, confidence, metadata")
      .eq("org_id", ctx.org_id)
      .or(
        `source_node.in.(${allNodeIds.map((id) => `"${id}"`).join(",")}),` +
        `target_node.in.(${allNodeIds.map((id) => `"${id}"`).join(",")})`
      );
    if (fetchErr) throw new Error(`kg_edges fetch failed: ${fetchErr.message}`);

    const existingByKey = new Map<string, ExistingEdge>();
    for (const row of (existing ?? []) as ExistingEdge[]) {
      existingByKey.set(edgeKey(row.source_node, row.target_node, row.relation), row);
    }

    const toInsert: Resolved[] = [];
    const toUpdate: Array<{ id: string; provenance: KGProvenance; confidence: number; metadata: Record<string, unknown> }> = [];

    for (const r of resolved) {
      const key = edgeKey(r.source_node, r.target_node, r.relation);
      const match = existingByKey.get(key);
      if (!match) {
        toInsert.push(r);
        continue;
      }
      const newProvenance = strongerProvenance(match.provenance, r.provenance);
      const newConfidence = Math.max(match.confidence, r.confidence);
      
      // ATH-60: Implement edge weighting via metadata
      // Combine with weekly_cdr_2's metadata merging
      const existingWeight = (match.metadata as any)?.occurrence_count ?? 1;
      const newWeight = existingWeight + 1;
      const mergedMetadata = { ...((match.metadata as any) ?? {}), ...r.metadata, occurrence_count: newWeight };

      toUpdate.push({
        id: match.id,
        provenance: newProvenance,
        confidence: newConfidence,
        metadata: mergedMetadata
      });
    }


    for (const u of toUpdate) {
      const { error } = await supabase
        .from("kg_edges")
        .update({ 
          provenance: u.provenance, 
          confidence: u.confidence,
          metadata: u.metadata 
        })
        .eq("id", u.id)
        .eq("org_id", ctx.org_id);
      if (error) throw new Error(`kg_edges update failed: ${error.message}`);
    }


    if (toInsert.length > 0) {
      const uniqueToInsert = new Map<string, Resolved>();
      for (const r of toInsert) {
        const key = edgeKey(r.source_node, r.target_node, r.relation);
        if (!uniqueToInsert.has(key)) {
          uniqueToInsert.set(key, r);
        } else {
          const existing = uniqueToInsert.get(key)!;
          existing.provenance = strongerProvenance(existing.provenance, r.provenance);
          existing.confidence = Math.max(existing.confidence, r.confidence);
        }
      }

      const { error } = await supabase.from("kg_edges").insert(Array.from(uniqueToInsert.values()));
      if (error) throw new Error(`kg_edges insert failed: ${error.message}`);
    }
}

// ---- Combined graph upsert ------------------------------------

/**
 * Upsert nodes and then edges in a single withRLS session.
 *
 * Supabase JS has no multi-statement transaction API. Running nodes
 * and edges inside one withRLS() callback at least shares a single
 * Postgres connection and session context. The caller (builder.ts)
 * is responsible for the compensating rollback: if this throws,
 * call deleteByDocument() to remove any orphaned nodes.
 *
 * Returns the label→id map produced by upsertNodes so callers that
 * need it (e.g. tests) don't have to call upsertNodes separately.
 */
export async function upsertGraph(
  ctx: RLSContext,
  nodes: KGNode[],
  edges: KGEdge[]
): Promise<Map<string, string>> {
  return withRLS(ctx, async (supabase) => {
    // Inline the node upsert logic (same as upsertNodes but reuses the client)
    const nodeIdMap = await _upsertNodesWithClient(supabase, ctx, nodes);
    await _upsertEdgesWithClient(supabase, ctx, edges, nodeIdMap);
    return nodeIdMap;
  });
}

// ---- Delete by document ---------------------------------------

/**
 * Clean up graph contributions from a single document.
 *
 * - Nodes whose `source_documents` equals `[documentId]` are deleted
 *   outright (they have no other contributors). kg_edges referencing
 *   them cascade via the FK.
 * - Nodes mentioned by other docs have `documentId` removed from
 *   `source_documents` but otherwise survive.
 * - Edges whose `source_document = documentId` are deleted (they
 *   belong to this doc). Edges inferred from multiple docs are not
 *   tagged with a single source and are left alone.
 */
export async function deleteByDocument(
  ctx: RLSContext,
  documentId: string
): Promise<void> {
  await withRLS(ctx, async (supabase) => {
    if (!documentId) throw new Error("documentId is required");
    // 1. Load nodes that reference this doc
    const { data: nodes, error: fetchErr } = await supabase
      .from("kg_nodes")
      .select("id, source_documents")
      .eq("org_id", ctx.org_id)
      .contains("source_documents", [documentId]);
    if (fetchErr) throw new Error(`kg_nodes fetch failed: ${fetchErr.message}`);

    const orphanIds: string[] = [];
    const sharedNodes: Array<{ id: string; remaining: string[] }> = [];

    for (const row of (nodes ?? []) as Array<{ id: string; source_documents: string[] }>) {
      const remaining = (row.source_documents ?? []).filter((d) => d !== documentId);
      if (remaining.length === 0) {
        orphanIds.push(row.id);
      } else {
        sharedNodes.push({ id: row.id, remaining });
      }
    }

    // 2. Delete orphan nodes (edges cascade)
    if (orphanIds.length > 0) {
      const { error } = await supabase
        .from("kg_nodes")
        .delete()
        .in("id", orphanIds)
        .eq("org_id", ctx.org_id);
      if (error) throw new Error(`kg_nodes delete failed: ${error.message}`);
    }

    // 3. Update shared nodes — drop this doc from source_documents
    for (const n of sharedNodes) {
      const { error } = await supabase
        .from("kg_nodes")
        .update({ source_documents: n.remaining })
        .eq("id", n.id)
        .eq("org_id", ctx.org_id);
      if (error) throw new Error(`kg_nodes shared update failed: ${error.message}`);
    }

    // 4. Delete edges tagged with this doc as their sole source
    const { error: edgeErr } = await supabase
      .from("kg_edges")
      .delete()
      .eq("org_id", ctx.org_id)
      .eq("source_document", documentId);
    if (edgeErr) throw new Error(`kg_edges delete failed: ${edgeErr.message}`);
  });
}

// ---- Internals ------------------------------------------------

type ExistingNode = {
  id: string;
  label: string;
  entity_type: string;
  department_ids: string[] | null;
  source_documents: string[] | null;
  visibility: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
};

type ExistingEdge = {
  id: string;
  source_node: string;
  target_node: string;
  relation: string;
  provenance: KGProvenance;
  confidence: number;
  metadata: Record<string, unknown> | null;
};


function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...a].sort();
  const other = [...b].sort();
  for (let i = 0; i < sorted.length; i++) if (sorted[i] !== other[i]) return false;
  return true;
}

// Mirror of maxVisibility from extractor but operates on raw strings
// (kg_nodes.visibility is `visibility_level` enum — we treat the DB
// value as authoritative and never widen to "public" accidentally).
const VISIBILITY_RANK: Record<string, number> = {
  restricted: 0,
  confidential: 1,
  department: 2,
  bi_accessible: 3,
  org_wide: 4,
};

function maxVisibilityRaw(a: string, b: string): string {
  // Gracefully handle potentially null/undefined values from DB
  const valA = a || "restricted";
  const valB = b || "restricted";

  if (!(valA in VISIBILITY_RANK)) {
    logger.warn({ value: valA }, "[storage] Unrecognised visibility value in maxVisibilityRaw — falling back to restricted");
    return valB;
  }
  if (!(valB in VISIBILITY_RANK)) {
    logger.warn({ value: valB }, "[storage] Unrecognised visibility value in maxVisibilityRaw — falling back to restricted");
    return valA;
  }
  return VISIBILITY_RANK[valA] >= VISIBILITY_RANK[valB] ? valA : valB;
}

// Export a suitable supabase client type for tests that want it
export type { SupabaseClient };
