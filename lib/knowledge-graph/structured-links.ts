// ============================================================
// lib/knowledge-graph/structured-links.ts (REFOCUS §5.3)
//
// Converts structured dependency/blocking links captured by the
// fetchers (Jira issue links, Linear relations, GitHub closing
// references — stored in documents.metadata.structured_links)
// into graph nodes + edges.
//
// These links are stated explicitly by the source system, so all
// edges are provenance EXTRACTED with confidence 1.0 — no LLM.
// ============================================================

import type { ExtractionResult, KGEdge, KGNode, StructuredLink, Visibility } from "./types";

const VALID_RELATIONS = new Set([
  "BLOCKS",
  "BLOCKED_BY",
  "DEPENDS_ON",
  "RELATED_TO",
  "RESOLVES",
]);

export interface StructuredLinkDoc {
  id: string;
  org_id: string;
  title: string | null;
  department_id: string | null;
  visibility: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Build nodes/edges from a document's structured_links metadata.
 * Returns an empty result when the document carries no links.
 */
export function buildStructuredLinkGraph(doc: StructuredLinkDoc): ExtractionResult {
  const links = (doc.metadata?.structured_links ?? []) as StructuredLink[];
  const selfLabel = (doc.title ?? "").trim();
  if (!Array.isArray(links) || links.length === 0 || !selfLabel) {
    return { nodes: [], edges: [] };
  }

  const selfType =
    (doc.metadata?.resource_type as string) === "pull_request" ? "pull_request" : "ticket";
  // Blocking/dependency links are org_wide: cross-functional blocker views
  // require that "ticket A blocks ticket B" is visible across departments.
  const visibility: Visibility = "org_wide";
  const departmentIds = doc.department_id ? [doc.department_id] : [];

  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];
  const seenNodes = new Set<string>();

  const addNode = (label: string, entityType: string) => {
    const key = `${label}::${entityType}`;
    if (seenNodes.has(key)) return;
    seenNodes.add(key);
    nodes.push({
      org_id: doc.org_id,
      label,
      entity_type: entityType,
      department_ids: departmentIds,
      visibility,
      source_documents: [doc.id],
      metadata: { structured: true },
    });
  };

  addNode(selfLabel, selfType);

  for (const link of links) {
    const targetLabel = (link?.target_label ?? "").trim();
    if (!targetLabel || !VALID_RELATIONS.has(link.relation)) continue;
    if (targetLabel === selfLabel) continue;

    const targetType = link.target_entity_type ?? "ticket";
    addNode(targetLabel, targetType);

    // RESOLVES is emitted from the resolving PR; the canonical relation is
    // RESOLVED_BY on the resolved entity, so swap direction here.
    const swapped = link.relation === "RESOLVES";
    edges.push({
      org_id: doc.org_id,
      source_label: swapped ? targetLabel : selfLabel,
      source_entity_type: swapped ? targetType : selfType,
      target_label: swapped ? selfLabel : targetLabel,
      target_entity_type: swapped ? selfType : targetType,
      relation: swapped ? "RESOLVED_BY" : link.relation,
      provenance: "EXTRACTED",
      confidence: 1.0,
      source_document: doc.id,
      department_id: doc.department_id,
      visibility,
      metadata: { structured: true },
    });
  }

  return { nodes, edges };
}
