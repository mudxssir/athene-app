// ============================================================
// my-work.ts — "My Work" blocker view read layer (REFOCUS §6.1)
//
// For the signed-in user: resolve their person node, collect
// their open items (tickets / PRs), and traverse
// BLOCKS / BLOCKED_BY / DEPENDS_ON edges cross-source to build
// each item's blocker chain with owner + provenance.
//
// All reads run inside withRLS() so org isolation is enforced.
// ============================================================

import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
import { resolveEntity } from "./entity-resolver";
import type { GraphNode, GraphEdge } from "./query";

const ITEM_ENTITY_TYPES = new Set(["ticket", "pull_request"]);
const BLOCKER_RELATIONS = ["BLOCKS", "BLOCKED_BY", "DEPENDS_ON"];
const CLOSED_STATUSES = new Set([
  "done", "closed", "merged", "resolved", "cancelled", "canceled", "completed",
]);
const MAX_ITEMS = 30;

function sanitizeForPostgrest(value: string): string {
  return value.replace(/[",\\.()]/g, "");
}

function quotedIdList(ids: string[]): string {
  return ids.map((id) => `"${sanitizeForPostgrest(id)}"`).join(",");
}

export type BlockerSource = {
  documentId: string;
  title: string | null;
  url: string | null;
  sourceType: string | null;
};

export type BlockerCard = {
  node: GraphNode;
  /** Relation as seen from the blocked item: it is blocked by / depends on this node. */
  relation: string;
  provenance: string;
  confidence: number;
  /** When the blocking edge was first recorded — "blocked since". */
  blockedSince: string | null;
  owner: { id: string; label: string } | null;
  source: BlockerSource | null;
  /** Second-hop blockers: what this blocker is itself waiting on. */
  upstream: BlockerCard[];
};

export type MyWorkItem = {
  node: GraphNode;
  url: string | null;
  blockers: BlockerCard[];
};

export type MyWorkResult = {
  person: GraphNode | null;
  items: MyWorkItem[];
};

type EdgeWithNodes = GraphEdge & {
  created_at?: string;
  source: GraphNode | null;
  target: GraphNode | null;
};

function nodeUrl(node: GraphNode): string | null {
  const url = (node.metadata as Record<string, unknown> | undefined)?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function isOpen(node: GraphNode): boolean {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  const status = String(meta.status ?? meta.state ?? "").toLowerCase();
  return !CLOSED_STATUSES.has(status);
}

/**
 * Normalize a blocker edge relative to a set of "subject" node IDs.
 * Returns the blocker node and the relation from the subject's view,
 * or null if the edge doesn't describe something blocking a subject.
 *
 *   subject BLOCKED_BY X   → X blocks subject
 *   X BLOCKS subject       → X blocks subject
 *   subject DEPENDS_ON X   → subject depends on X
 */
function normalizeBlockerEdge(
  edge: EdgeWithNodes,
  subjectIds: Set<string>
): { subjectId: string; blocker: GraphNode; relation: string } | null {
  if (edge.relation === "BLOCKED_BY" || edge.relation === "DEPENDS_ON") {
    if (subjectIds.has(edge.source_node) && edge.target) {
      return { subjectId: edge.source_node, blocker: edge.target, relation: edge.relation };
    }
  }
  if (edge.relation === "BLOCKS") {
    if (subjectIds.has(edge.target_node) && edge.source) {
      return { subjectId: edge.target_node, blocker: edge.source, relation: "BLOCKED_BY" };
    }
  }
  return null;
}

export async function getMyWork(
  ctx: RLSContext,
  identity: { displayName?: string | null; email?: string | null }
): Promise<MyWorkResult> {
  // ── 1. Resolve the user's person node ──
  const lookups = [
    identity.displayName?.trim(),
    identity.email?.split("@")[0]?.replace(/[._-]+/g, " ").trim(),
  ].filter((q): q is string => !!q);

  let personId: string | null = null;
  for (const q of lookups) {
    const candidates = await resolveEntity(ctx, q, { entityType: "person", limit: 1 });
    if (candidates.length > 0) {
      personId = candidates[0].canonicalNodeId;
      break;
    }
  }

  if (!personId) return { person: null, items: [] };

  return withRLS(ctx, async (supabase) => {
    const { data: personRow, error: personErr } = await supabase
      .from("kg_nodes")
      .select("*")
      .eq("org_id", ctx.org_id)
      .eq("id", personId)
      .maybeSingle();
    if (personErr) throw new Error(`[my-work] person fetch failed: ${personErr.message}`);
    if (!personRow) return { person: null, items: [] };
    const person = personRow as GraphNode;

    // ── 2. The user's items: tickets/PRs linked via OWNS / WORKS_ON ──
    const { data: itemEdges, error: itemErr } = await supabase
      .from("kg_edges")
      .select("*, source:kg_nodes!source_node(*), target:kg_nodes!target_node(*)")
      .eq("org_id", ctx.org_id)
      .in("relation", ["OWNS", "WORKS_ON"])
      .or(
        `source_node.eq.${sanitizeForPostgrest(person.id)},` +
        `target_node.eq.${sanitizeForPostgrest(person.id)}`
      );
    if (itemErr) throw new Error(`[my-work] item fetch failed: ${itemErr.message}`);

    const itemMap = new Map<string, GraphNode>();
    for (const e of (itemEdges ?? []) as EdgeWithNodes[]) {
      const neighbor = e.source_node === person.id ? e.target : e.source;
      if (neighbor && ITEM_ENTITY_TYPES.has(neighbor.entity_type as string)) {
        itemMap.set(neighbor.id, neighbor);
      }
    }

    const items = Array.from(itemMap.values()).filter(isOpen).slice(0, MAX_ITEMS);
    if (items.length === 0) return { person, items: [] };

    const itemIds = items.map((i) => i.id);
    const itemIdSet = new Set(itemIds);

    // ── 3. Hop 1: blockers of my items ──
    const fetchBlockerEdges = async (ids: string[]): Promise<EdgeWithNodes[]> => {
      if (ids.length === 0) return [];
      const { data, error } = await supabase
        .from("kg_edges")
        .select("*, source:kg_nodes!source_node(*), target:kg_nodes!target_node(*)")
        .eq("org_id", ctx.org_id)
        .in("relation", BLOCKER_RELATIONS)
        .or(
          `source_node.in.(${quotedIdList(ids)}),target_node.in.(${quotedIdList(ids)})`
        );
      if (error) throw new Error(`[my-work] blocker fetch failed: ${error.message}`);
      return (data ?? []) as EdgeWithNodes[];
    };

    const hop1Edges = await fetchBlockerEdges(itemIds);
    type RawBlocker = {
      subjectId: string;
      blocker: GraphNode;
      relation: string;
      edge: EdgeWithNodes;
    };
    const hop1: RawBlocker[] = [];
    for (const e of hop1Edges) {
      const n = normalizeBlockerEdge(e, itemIdSet);
      if (n && n.blocker.id !== n.subjectId) hop1.push({ ...n, edge: e });
    }

    // ── 4. Hop 2: what those blockers are themselves waiting on ──
    const hop1BlockerIds = Array.from(
      new Set(hop1.map((b) => b.blocker.id).filter((id) => !itemIdSet.has(id)))
    );
    const hop1BlockerIdSet = new Set(hop1BlockerIds);
    const hop2Edges = await fetchBlockerEdges(hop1BlockerIds);
    const hop2: RawBlocker[] = [];
    for (const e of hop2Edges) {
      const n = normalizeBlockerEdge(e, hop1BlockerIdSet);
      if (n && n.blocker.id !== n.subjectId && !itemIdSet.has(n.blocker.id)) {
        hop2.push({ ...n, edge: e });
      }
    }

    // ── 5. Owners of all blocker nodes (OWNS edge from a person) ──
    const allBlockerIds = Array.from(
      new Set([...hop1, ...hop2].map((b) => b.blocker.id))
    );
    const owners = new Map<string, { id: string; label: string }>();
    if (allBlockerIds.length > 0) {
      const { data: ownEdges, error: ownErr } = await supabase
        .from("kg_edges")
        .select("*, source:kg_nodes!source_node(*), target:kg_nodes!target_node(*)")
        .eq("org_id", ctx.org_id)
        .in("relation", ["OWNS", "WORKS_ON"])
        .or(
          `source_node.in.(${quotedIdList(allBlockerIds)}),` +
          `target_node.in.(${quotedIdList(allBlockerIds)})`
        );
      if (ownErr) throw new Error(`[my-work] owner fetch failed: ${ownErr.message}`);
      for (const e of (ownEdges ?? []) as EdgeWithNodes[]) {
        // Person can sit on either end; prefer OWNS over WORKS_ON.
        const pairs = [
          { personNode: e.source, thingId: e.target_node },
          { personNode: e.target, thingId: e.source_node },
        ];
        for (const { personNode, thingId } of pairs) {
          if (
            personNode &&
            personNode.entity_type === "person" &&
            allBlockerIds.includes(thingId) &&
            (e.relation === "OWNS" || !owners.has(thingId))
          ) {
            owners.set(thingId, { id: personNode.id, label: personNode.label });
          }
        }
      }
    }

    // ── 6. Source documents for provenance deep links ──
    const docIds = Array.from(
      new Set(
        [...hop1, ...hop2]
          .flatMap((b) => [
            b.edge.source_document,
            (b.blocker.source_documents ?? [])[0],
          ])
          .filter((id): id is string => !!id)
      )
    );
    const docs = new Map<string, BlockerSource>();
    if (docIds.length > 0) {
      const { data: docRows, error: docErr } = await supabase
        .from("documents")
        .select("id, title, external_url, source_type")
        .eq("org_id", ctx.org_id)
        .in("id", docIds);
      if (docErr) throw new Error(`[my-work] doc fetch failed: ${docErr.message}`);
      for (const d of docRows ?? []) {
        docs.set(d.id, {
          documentId: d.id,
          title: d.title ?? null,
          url: d.external_url ?? null,
          sourceType: d.source_type ?? null,
        });
      }
    }

    const toCard = (b: RawBlocker, upstream: BlockerCard[]): BlockerCard => {
      const docId = b.edge.source_document ?? (b.blocker.source_documents ?? [])[0];
      return {
        node: b.blocker,
        relation: b.relation,
        provenance: b.edge.provenance,
        confidence: b.edge.confidence ?? 1,
        blockedSince: b.edge.created_at ?? null,
        owner: owners.get(b.blocker.id) ?? null,
        source: docId ? docs.get(docId) ?? null : null,
        upstream,
      };
    };

    const hop2BySubject = new Map<string, RawBlocker[]>();
    for (const b of hop2) {
      const list = hop2BySubject.get(b.subjectId) ?? [];
      list.push(b);
      hop2BySubject.set(b.subjectId, list);
    }

    const resultItems: MyWorkItem[] = items.map((node) => ({
      node,
      url: nodeUrl(node),
      blockers: hop1
        .filter((b) => b.subjectId === node.id)
        .map((b) =>
          toCard(
            b,
            (hop2BySubject.get(b.blocker.id) ?? []).map((u) => toCard(u, []))
          )
        ),
    }));

    // Blocked items first, then most blockers first.
    resultItems.sort((a, b) => b.blockers.length - a.blockers.length);

    return { person, items: resultItems };
  });
}
