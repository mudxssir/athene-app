// ============================================================
// lib/knowledge-graph/backfill-entity-resolution.ts
//
// Processes existing kg_nodes that predate the alias table and
// the extraction-time alias registration.
//
// For each root node with a label_embedding, finds similar root
// nodes via find_similar_nodes() RPC:
//   similarity >= merge_threshold  → set canonical_id (hard merge)
//   similarity >= alias_threshold  → register alias only
//
// The job is resumable: it accepts a cursor (last processed node
// UUID) and returns the next cursor or null when complete.
// The worker chains itself via QStash for large orgs.
// ============================================================

// SERVICE-ROLE JUSTIFICATION: resumable per-org backfill runs as a QStash
// background job (no user RLS context); writes canonical_id/aliases only.
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { registerAlias } from "./entity-resolver";
import { KG_CONFIG } from "./config";

export interface BackfillResult {
  processed: number;
  aliasesRegistered: number;
  merged: number;
  nextCursor: string | null;
}

/**
 * Process one batch of root nodes for an org.
 *
 * @param orgId     — org to process
 * @param cursor    — last processed node UUID (null = start from beginning)
 * @param batchSize — nodes per call (default from KG_CONFIG)
 */
export async function runEntityResolutionBackfill(
  orgId: string,
  cursor: string | null = null,
  batchSize = KG_CONFIG.backfill.batch_size
): Promise<BackfillResult> {
  const { merge_similarity_threshold, alias_similarity_threshold } =
    KG_CONFIG.entity_resolution;

  // Load a batch of root nodes with embeddings, ordered by id for stable pagination
  let query = supabaseAdmin
    .from("kg_nodes")
    .select("id, label, entity_type, label_embedding")
    .eq("org_id", orgId)
    .is("canonical_id", null)
    .not("label_embedding", "is", null)
    .order("id", { ascending: true })
    .limit(batchSize);

  if (cursor) {
    query = query.gt("id", cursor);
  }

  const { data: nodes, error } = await query;
  if (error) {
    logger.error({ orgId, err: error.message }, "[backfill-entity-resolution] Node fetch failed");
    throw new Error(`Backfill node fetch failed: ${error.message}`);
  }

  if (!nodes || nodes.length === 0) {
    return { processed: 0, aliasesRegistered: 0, merged: 0, nextCursor: null };
  }

  let aliasesRegistered = 0;
  let merged = 0;

  for (const node of nodes) {
    const embedding = node.label_embedding as number[];
    if (!embedding) continue;

    // Find similar root nodes above the alias threshold
    const { data: similar, error: simErr } = await supabaseAdmin.rpc(
      "find_similar_nodes",
      {
        p_org_id:      orgId,
        p_node_id:     node.id,
        p_embedding:   embedding,
        p_entity_type: node.entity_type,
        p_threshold:   alias_similarity_threshold,
        p_limit:       KG_CONFIG.entity_resolution.max_candidates,
      }
    );

    if (simErr) {
      logger.warn(
        { orgId, nodeId: node.id, err: simErr.message },
        "[backfill-entity-resolution] find_similar_nodes failed — skipping node"
      );
      continue;
    }

    for (const match of similar ?? []) {
      if (match.similarity >= merge_similarity_threshold) {
        // Hard merge: point this node at the similar node as canonical.
        // We pick the match as canonical (it was found first in id order).
        const { error: mergeErr } = await supabaseAdmin
          .from("kg_nodes")
          .update({ canonical_id: match.node_id })
          .eq("id", node.id)
          .eq("org_id", orgId)
          .is("canonical_id", null); // guard: only merge if still a root

        if (mergeErr) {
          logger.warn(
            { orgId, nodeId: node.id, canonicalId: match.node_id, err: mergeErr.message },
            "[backfill-entity-resolution] Merge update failed"
          );
        } else {
          merged++;
          // Register the merged label as alias of the canonical
          await registerAlias(
            orgId,
            match.node_id,
            node.label,
            "backfill",
            match.similarity,
            embedding
          );
          aliasesRegistered++;
        }
      } else {
        // Alias only: different surface forms of the same entity
        await registerAlias(
          orgId,
          match.node_id,
          node.label,
          "backfill",
          match.similarity,
          embedding
        );
        aliasesRegistered++;
      }
    }
  }

  const lastNode = nodes[nodes.length - 1];
  const nextCursor = nodes.length < batchSize ? null : lastNode.id;

  logger.info(
    { orgId, processed: nodes.length, aliasesRegistered, merged, nextCursor },
    "[backfill-entity-resolution] Batch complete"
  );

  return {
    processed: nodes.length,
    aliasesRegistered,
    merged,
    nextCursor,
  };
}

/**
 * Run the backfill across all orgs (used for a one-shot full run in dev).
 * In production, use the worker + QStash chaining per org instead.
 */
export async function runEntityResolutionBackfillAllOrgs(): Promise<void> {
  const { data: orgs, error } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to fetch orgs: ${error.message}`);

  for (const org of orgs ?? []) {
    let cursor: string | null = null;
    let iterations = 0;

    do {
      const result = await runEntityResolutionBackfill(org.id, cursor);
      cursor = result.nextCursor;
      iterations++;

      if (iterations > 1000) {
        logger.warn({ orgId: org.id }, "[backfill-entity-resolution] Safety limit hit — stopping");
        break;
      }
    } while (cursor !== null);
  }
}
