// ============================================================
// lib/knowledge-graph/structured-records.ts (P4-7)
//
// Converts CRM record annotations (structured_owners + structured_account,
// emitted by Salesforce/HubSpot record fetchers) into deterministic KG edges:
//   record  —OWNS←            person   (owner → OWNS → record)
//   record  —TIED_TO_ACCOUNT→ account  (record → account)
//
// No LLM, confidence 1.0. Mirrors structured-owners.ts (work_item) but for the
// record shape, with a record-appropriate self entity_type and an account node.
// ============================================================

import type { ExtractionResult, KGEdge, KGNode, EntityType, Visibility } from "./types";
import type { StructuredOwner } from "@/lib/integrations/base";

export interface StructuredRecordDoc {
  id: string;
  org_id: string;
  title: string | null;
  department_id: string | null;
  visibility: string | null;
  metadata: Record<string, unknown> | null;
}

// CRM resource_type → KG entity_type for the record self node. Connectors use
// inconsistent singular/plural forms (SF contacts emit 'contact', accounts emit
// 'accounts'), so both are mapped.
const RECORD_ENTITY_TYPE: Record<string, EntityType> = {
  opportunity: "deal",
  opportunities: "deal",
  deal: "deal",
  deals: "deal",
  contact: "contact",
  contacts: "contact",
  account: "account",
  accounts: "account",
  company: "account",
  companies: "account",
  case: "ticket",
  cases: "ticket",
};

function selfEntityType(resourceType: string): EntityType {
  return RECORD_ENTITY_TYPE[resourceType] ?? "concept";
}

/**
 * Build deterministic owner (OWNS) and account (TIED_TO_ACCOUNT) edges for a CRM
 * record. Returns empty when the record carries neither annotation.
 *
 * Visibility split mirrors P2-5: the record + owner edge inherit the document's
 * visibility (ownership is org-readable only via the item); person and account
 * nodes are org_wide so cross-department dedup yields one node per human/account.
 */
export function buildStructuredRecordGraph(doc: StructuredRecordDoc): ExtractionResult {
  const owners = (doc.metadata?.structured_owners ?? []) as StructuredOwner[];
  const accountName = (doc.metadata?.structured_account as string | undefined)?.trim() ?? "";
  const selfLabel = (doc.title ?? "").trim();

  const hasOwners = Array.isArray(owners) && owners.length > 0;
  if ((!hasOwners && !accountName) || !selfLabel) {
    return { nodes: [], edges: [] };
  }

  const itemVisibility: Visibility = (doc.visibility ?? "department") as Visibility;
  const sharedVisibility: Visibility = "org_wide";
  const departmentIds = doc.department_id ? [doc.department_id] : [];
  const resourceType = (doc.metadata?.resource_type as string) ?? "record";
  const recordType = selfEntityType(resourceType);

  const nodes: KGNode[] = [];
  const edges: KGEdge[] = [];

  // Self node (the CRM record)
  nodes.push({
    org_id: doc.org_id,
    label: selfLabel,
    entity_type: recordType,
    department_ids: departmentIds,
    visibility: itemVisibility,
    source_documents: [doc.id],
    metadata: { structured: true },
  });

  // Owner → OWNS → record
  const seenPersons = new Set<string>();
  for (const owner of owners) {
    const personLabel = (owner.person_label ?? "").trim();
    if (!personLabel || owner.relation !== "OWNS") continue;

    if (!seenPersons.has(personLabel)) {
      seenPersons.add(personLabel);
      const personMeta: Record<string, unknown> = { structured: true };
      if (owner.provider_account_id) personMeta.provider_account_id = owner.provider_account_id;
      nodes.push({
        org_id: doc.org_id,
        label: personLabel,
        entity_type: "person",
        department_ids: departmentIds,
        visibility: sharedVisibility,
        source_documents: [doc.id],
        metadata: personMeta,
      });
    }

    edges.push({
      org_id: doc.org_id,
      source_label: personLabel,
      source_entity_type: "person",
      target_label: selfLabel,
      target_entity_type: recordType,
      relation: "OWNS",
      provenance: "EXTRACTED",
      confidence: 1.0,
      source_document: doc.id,
      department_id: doc.department_id,
      visibility: itemVisibility,
      metadata: { structured: true },
    });
  }

  // record → TIED_TO_ACCOUNT → account
  if (accountName) {
    nodes.push({
      org_id: doc.org_id,
      label: accountName,
      entity_type: "account",
      department_ids: departmentIds,
      visibility: sharedVisibility,
      source_documents: [doc.id],
      metadata: { structured: true },
    });
    edges.push({
      org_id: doc.org_id,
      source_label: selfLabel,
      source_entity_type: recordType,
      target_label: accountName,
      target_entity_type: "account",
      relation: "TIED_TO_ACCOUNT",
      provenance: "EXTRACTED",
      confidence: 1.0,
      source_document: doc.id,
      department_id: doc.department_id,
      visibility: itemVisibility,
      metadata: { structured: true },
    });
  }

  return { nodes, edges };
}
