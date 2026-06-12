// ============================================================
// lib/knowledge-graph/structured-owners.ts (P2-3)
//
// Converts structured owner annotations emitted by work_item
// fetchers (Jira, Linear, GitHub, Zendesk) into PERSON nodes
// and ownership edges (OWNS, WORKS_ON, REPORTED_BY, DECIDED_BY).
//
// These are deterministic — no LLM, confidence 1.0.
// Stored in documents.metadata.structured_owners at index time.
// ============================================================

import type { ExtractionResult, KGEdge, KGNode, Visibility } from "./types";
import type { StructuredOwner } from "@/lib/integrations/base";

export interface StructuredOwnerDoc {
  id: string;
  org_id: string;
  title: string | null;
  department_id: string | null;
  visibility: string | null;
  metadata: Record<string, unknown> | null;
}

const VALID_RELATIONS = new Set<string>(["OWNS", "WORKS_ON", "REPORTED_BY", "DECIDED_BY"]);

/**
 * Build PERSON nodes and ownership edges from a document's
 * structured_owners metadata.  Returns empty result when absent.
 */
export function buildStructuredOwnerGraph(doc: StructuredOwnerDoc): ExtractionResult {
  const owners = (doc.metadata?.structured_owners ?? []) as StructuredOwner[];
  const selfLabel = (doc.title ?? "").trim();
  if (!Array.isArray(owners) || owners.length === 0 || !selfLabel) {
    return { nodes: [], edges: [] };
  }

  const visibility = (doc.visibility ?? "department") as Visibility;
  const departmentIds = doc.department_id ? [doc.department_id] : [];
  const resourceType = (doc.metadata?.resource_type as string) ?? "ticket";
  const selfEntityType = resourceType === "pull_request" ? "pull_request" : "ticket";

  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];
  const seenPersons = new Set<string>();

  // Self node (the work item)
  nodes.push({
    org_id: doc.org_id,
    label: selfLabel,
    entity_type: selfEntityType,
    department_ids: departmentIds,
    visibility,
    source_documents: [doc.id],
    metadata: { structured: true },
  });

  for (const owner of owners) {
    const personLabel = (owner.person_label ?? "").trim();
    if (!personLabel || !VALID_RELATIONS.has(owner.relation)) continue;

    if (!seenPersons.has(personLabel)) {
      seenPersons.add(personLabel);
      const personMeta: Record<string, unknown> = { structured: true };
      if (owner.provider_account_id) {
        personMeta.provider_account_id = owner.provider_account_id;
      }
      nodes.push({
        org_id: doc.org_id,
        label: personLabel,
        entity_type: "person",
        department_ids: departmentIds,
        visibility,
        source_documents: [doc.id],
        metadata: personMeta,
      });
    }

    edges.push({
      org_id: doc.org_id,
      source_label: personLabel,
      source_entity_type: "person",
      target_label: selfLabel,
      target_entity_type: selfEntityType,
      relation: owner.relation,
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
