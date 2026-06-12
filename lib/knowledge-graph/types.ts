// ============================================================
// Knowledge Graph shared types (ATH-58)
//
// These types mirror the kg_nodes / kg_edges columns and are
// the contract between the extractor (ATH-58) and the storage
// layer (ATH-59).
// ============================================================

export type EntityType =
  | "person"
  | "project"
  | "service"
  | "concept"
  | "team"
  | "technology"
  | "process"
  | "organization"
  | "product"
  // Decision Memory
  | "decision"
  | "risk"
  | "obligation"
  | "metric"
  // RevOps module
  | "deal"
  | "account"
  | "contact"
  | "persona"
  | "objection"
  | "win_reason"
  | "loss_reason"
  | "competitor"
  // Engineering module
  | "incident"
  | "runbook"
  | "ticket"
  | "pull_request"
  | "tech_debt_item"
  | "sla_item"
  | "on_call_rotation"
  | "architecture_decision"
  // Customer Success module
  | "customer"
  | "feature_request"
  | "bug_report"
  | "renewal"
  | "health_score"
  | "success_plan"
  // Legal & Compliance module
  | "contract"
  | "clause"
  | "counterparty"
  | "regulation"
  | "risk_item"
  | "audit_finding";

export type Visibility = "org_wide" | "department" | "private" | "team";

/** How we arrived at this edge. */
export type KGProvenance = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/**
 * Relation types supported by the graph.
 * Open string so adapters can emit novel relations, but these
 * are the canonical ones the UI knows how to render.
 */
export type KGRelation =
  | "DEPENDS_ON"
  | "OWNS"
  | "FEEDS"
  | "MENTIONS"
  | "USES"
  | "RELATED_TO"
  | "PART_OF"
  | "WORKS_ON"
  // Decision Memory
  | "DECIDED_BY"
  | "SUPERSEDES"
  | "LED_TO"
  | "REVERSED_BY"
  | "APPLIED_TO"
  // Incident / Engineering
  | "CAUSED"
  | "RESOLVED_BY"
  | "BLOCKS"
  | "BLOCKED_BY"
  | "DEPLOYED_WITH"
  | "DEPRECATED_BY"
  | "ONCALL_FOR"
  | "CAUSED_INCIDENT"
  // RevOps
  | "COMPETES_WITH"
  | "OBJECTED_TO"
  | "WON_AGAINST"
  | "LOST_TO"
  | "EXPANDED_FROM"
  | "CHURNED_FROM"
  | "INFLUENCED_BY"
  // Customer Success
  | "REPORTED_BY"
  | "AFFECTS"
  | "REQUESTED_BY"
  | "RESOLVED_VIA"
  | "IMPACTS_RENEWAL"
  | "TIED_TO_ACCOUNT"
  // Legal
  | "OBLIGATES"
  | "RESTRICTS"
  | "SUBJECT_TO"
  | "GOVERNS"
  | "BREACHES"
  | "RISKS"
  | (string & {});

/**
 * Chunk passed into the extractor. The body is ephemeral (RAM only).
 * department_id / visibility / org_id / document_id are carried
 * forward onto every emitted node and edge.
 */
export type ExtractorChunk = {
  text: string;
  chunk_index: number;
  org_id: string;
  document_id: string;
  department_id?: string | null;
  visibility: Visibility;
  /** Optional passthrough metadata (e.g. source_type) used by dual-prompt decision guard */
  metadata?: Record<string, unknown>;
};

/** Temporal context extracted for decision-type entities. */
export type TemporalMetadata = {
  occurred_at?: string;
  decision_maker?: string;
  alternatives_considered?: string[];
  outcome?: string;
  confidence_of_date?: number;
};

/** A node to be upserted into kg_nodes. */
export type KGNode = {
  org_id: string;
  label: string;
  entity_type: EntityType | (string & {});
  department_ids: string[];
  visibility: Visibility;
  source_documents: string[];
  description?: string | null;
  community?: number | null;
  metadata?: Record<string, unknown>;
  temporal_metadata?: TemporalMetadata | null;
  updated_at?: string;
};

/** An edge to be upserted into kg_edges. Source/target are labels, not UUIDs. */
export type KGEdge = {
  org_id: string;
  source_label: string;
  source_entity_type: EntityType | (string & {});
  target_label: string;
  target_entity_type: EntityType | (string & {});
  relation: KGRelation;
  provenance: KGProvenance;
  confidence: number;
  source_document?: string | null;
  department_id?: string | null;
  visibility: Visibility;
  metadata?: Record<string, unknown>;
};

/** Result of an extraction pass. */
export type ExtractionResult = {
  nodes: KGNode[];
  edges: KGEdge[];
};

/**
 * A dependency/blocking link stated structurally by the source system
 * (Jira issue links, Linear relations, GitHub closing references).
 * Emitted by fetchers into chunk metadata as `structured_links`, then
 * converted to EXTRACTED/1.0 edges by the graph builder (REFOCUS §5.3) —
 * no LLM involved.
 *
 * Direction: this document's entity → target. "RESOLVES" is the one
 * exception: the builder swaps it to `target —RESOLVED_BY→ this entity`.
 */
export type StructuredLink = {
  relation: "BLOCKS" | "BLOCKED_BY" | "DEPENDS_ON" | "RELATED_TO" | "RESOLVES" | "PART_OF";
  /** Human-readable label of the linked entity, e.g. "PROJ-123: Fix login" */
  target_label: string;
  /** Entity type of the target node (defaults to "ticket") */
  target_entity_type?: string;
};
