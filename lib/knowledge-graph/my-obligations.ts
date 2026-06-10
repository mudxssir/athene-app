// ============================================================
// my-obligations.ts — personal obligations surface (REFOCUS §6.2)
//
// Fetches obligation nodes linked to the signed-in user via:
//   - person OWNS obligation
//   - person WORKS_ON obligation
//   - obligation OBLIGATES person
//
// Obligations are sorted: overdue first, then soonest due.
// All reads run inside withRLS() for org isolation.
// ============================================================

import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
import { resolveEntity } from "./entity-resolver";
import type { GraphNode, GraphEdge } from "./query";

const CLOSED_STATUSES = new Set([
  "done", "closed", "resolved", "completed", "cancelled", "canceled", "dismissed",
]);
const MAX_OBLIGATIONS = 50;

export type ObligationItem = {
  node: GraphNode;
  dueDate: string | null;
  status: string | null;
  actor: string | null;
  isOverdue: boolean;
  source: { documentId: string; title: string | null; url: string | null; sourceType: string | null } | null;
};

export type MyObligationsResult = {
  person: GraphNode | null;
  items: ObligationItem[];
};

type EdgeWithNodes = GraphEdge & {
  created_at?: string;
  source: GraphNode | null;
  target: GraphNode | null;
};

function sanitize(v: string): string {
  return v.replace(/[",\\.()]/g, "");
}

function isOpen(node: GraphNode): boolean {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  const status = String(meta.status ?? meta.state ?? "").toLowerCase();
  return !CLOSED_STATUSES.has(status);
}

function parseDueDate(node: GraphNode): string | null {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  const raw = meta.due_date ?? meta.deadline ?? meta.due ?? null;
  if (!raw || typeof raw !== "string") return null;
  return raw;
}

function parseStatus(node: GraphNode): string | null {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  const s = meta.status ?? meta.state ?? null;
  return s ? String(s) : null;
}

function parseActor(node: GraphNode): string | null {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  const a = meta.actor ?? meta.owner ?? meta.assignee ?? null;
  return a ? String(a) : null;
}

export async function getMyObligations(
  ctx: RLSContext,
  identity: { displayName?: string | null; email?: string | null }
): Promise<MyObligationsResult> {
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
    if (personErr) throw new Error(`[my-obligations] person fetch: ${personErr.message}`);
    if (!personRow) return { person: null, items: [] };
    const person = personRow as GraphNode;

    // Fetch edges in both directions:
    // OWNS/WORKS_ON from person → obligation
    // OBLIGATES from obligation → person
    const { data: edgeRows, error: edgeErr } = await supabase
      .from("kg_edges")
      .select("*, source:kg_nodes!source_node(*), target:kg_nodes!target_node(*)")
      .eq("org_id", ctx.org_id)
      .or(
        [
          // person is source, owns/works_on an obligation
          `and(relation.in.("OWNS","WORKS_ON"),source_node.eq.${sanitize(person.id)})`,
          // obligation obligates the person (person is target)
          `and(relation.eq.OBLIGATES,target_node.eq.${sanitize(person.id)})`,
        ].join(",")
      );
    if (edgeErr) throw new Error(`[my-obligations] edge fetch: ${edgeErr.message}`);

    const obligationMap = new Map<string, { node: GraphNode; docId: string | null }>();
    for (const e of (edgeRows ?? []) as EdgeWithNodes[]) {
      let candidate: GraphNode | null = null;
      let docId: string | null = null;

      if (e.relation === "OBLIGATES" && e.source?.entity_type === "obligation") {
        candidate = e.source;
        docId = e.source_document ?? null;
      } else if (
        (e.relation === "OWNS" || e.relation === "WORKS_ON") &&
        e.target?.entity_type === "obligation"
      ) {
        candidate = e.target;
        docId = e.source_document ?? null;
      }

      if (candidate && !obligationMap.has(candidate.id)) {
        obligationMap.set(candidate.id, { node: candidate, docId });
      }
    }

    const rawObligations = Array.from(obligationMap.values()).filter((o) => isOpen(o.node));

    if (rawObligations.length === 0) return { person, items: [] };

    // Fetch source documents
    const docIds = Array.from(
      new Set(rawObligations.map((o) => o.docId).filter((id): id is string => !!id))
    );
    const docs = new Map<string, { title: string | null; url: string | null; sourceType: string | null }>();
    if (docIds.length > 0) {
      const { data: docRows, error: docErr } = await supabase
        .from("documents")
        .select("id, title, external_url, source_type")
        .eq("org_id", ctx.org_id)
        .in("id", docIds);
      if (docErr) throw new Error(`[my-obligations] doc fetch: ${docErr.message}`);
      for (const d of docRows ?? []) {
        docs.set(d.id, { title: d.title ?? null, url: d.external_url ?? null, sourceType: d.source_type ?? null });
      }
    }

    const now = Date.now();
    const items: ObligationItem[] = rawObligations
      .map(({ node, docId }) => {
        const dueDate = parseDueDate(node);
        const dueMsAgo = dueDate ? now - new Date(dueDate).getTime() : null;
        const isOverdue = dueMsAgo !== null && !isNaN(dueMsAgo) && dueMsAgo > 0;
        const docRef = docId ? docs.get(docId) ?? null : null;
        return {
          node,
          dueDate,
          status: parseStatus(node),
          actor: parseActor(node),
          isOverdue,
          source: docRef ? { documentId: docId!, ...docRef } : null,
        };
      })
      .slice(0, MAX_OBLIGATIONS);

    // Sort: overdue first (soonest overdue last), then upcoming soonest first
    items.sort((a, b) => {
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    });

    return { person, items };
  });
}
