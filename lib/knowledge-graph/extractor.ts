// ============================================================
// extractor.ts — Entity & relationship extraction adapter (ATH-58)
//
// Also re-exports extractSchemaEntities from bi-chunking.ts so
// callers can import everything KG-related from this module.
//
// Runs LLM calls over each chunk and returns typed KGNode[] /
// KGEdge[]. The caller owns persistence.
//
// Two extraction passes run in parallel per chunk:
//   1. General entity/relation extraction (all source types)
//   2. Decision record extraction (qualifying source types only)
//
// Rule #2: chunks arrive in RAM and leave as graph structures.
// This file never touches Supabase.
// ============================================================

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { logger } from "@/lib/logger";
export { extractSchemaEntities } from "@/lib/integrations/bi-chunking";
import { resolveModelClient } from "@/lib/langgraph/llm-factory";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EntityType,
  ExtractionResult,
  ExtractorChunk,
  KGEdge,
  KGNode,
  KGProvenance,
  TemporalMetadata,
  Visibility,
} from "./types";
import {
  strongerProvenance,
  unionStrings,
  maxVisibility,
  nodeKey as makeNodeKey,
} from "./utils";
import {
  DECISION_EXTRACTION_PROMPT,
  DECISION_SOURCE_TYPES,
} from "./extractor-prompt";
import { resolveExtractionPrompt } from "./modules/resolver";

/** Resolve the dynamic prompt (base + active module addenda) for an org. */
async function loadPrompt(orgId: string): Promise<string> {
  return resolveExtractionPrompt(orgId);
}

// ---- Raw LLM response shape -----------------------------------

type RawEntity = {
  label?: unknown;
  entity_type?: unknown;
  description?: unknown;
  temporal_metadata?: unknown;
};

type RawRelationship = {
  source?: unknown;
  source_entity_type?: unknown;
  target?: unknown;
  target_entity_type?: unknown;
  relation?: unknown;
  provenance?: unknown;
  confidence?: unknown;
};

type RawExtraction = {
  entities?: RawEntity[];
  relationships?: RawRelationship[];
};

// ---- JSON coercion --------------------------------------------

/**
 * Extract the first JSON object from an LLM response. Haiku usually
 * returns clean JSON but occasionally wraps it in ```json fences or
 * adds a sentence — strip those defensively.
 */
function parseJSON(raw: string): RawExtraction | null {
  const trimmed = raw.trim();
  // fast path: raw JSON
  try {
    return JSON.parse(trimmed) as RawExtraction;
  } catch {
    // fall through
  }
  // strip ```json fences
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as RawExtraction;
    } catch {
      // fall through
    }
  }
  // first-brace-to-last-brace fallback
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as RawExtraction;
    } catch {
      return null;
    }
  }
  return null;
}

// ---- Normalization --------------------------------------------

const VALID_PROVENANCE = new Set<KGProvenance>(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);

function normLabel(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const s = x.trim().toLowerCase();
  return s.length === 0 || s.length > 200 ? null : s;
}

function normEntityType(x: unknown): EntityType | string | null {
  if (typeof x !== "string") return null;
  const s = x.trim().toLowerCase();
  return s.length === 0 ? null : s;
}

function normProvenance(x: unknown): KGProvenance {
  if (typeof x === "string" && VALID_PROVENANCE.has(x.toUpperCase() as KGProvenance)) {
    return x.toUpperCase() as KGProvenance;
  }
  return "AMBIGUOUS";
}

function normConfidence(x: unknown, provenance: KGProvenance): number {
  let n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) n = provenance === "EXTRACTED" ? 1.0 : 0.5;
  // Clamp to [0, 1]
  n = Math.max(0, Math.min(1, n));
  // EXTRACTED edges must be confidence 1.0 per prompt contract
  if (provenance === "EXTRACTED") n = 1.0;
  return n;
}

// ---- Raw LLM call helper -------------------------------------

async function llmExtract(
  systemPrompt: string,
  text: string,
  orgId: string
): Promise<RawExtraction | null> {
  // Up to 2 attempts: first normal, second with an explicit JSON reminder if parsing failed
  for (let attempt = 0; attempt <= 1; attempt++) {
    let raw: string;
    try {
      const llm = await resolveModelClient("medium", orgId);
      const jsonReminder = attempt > 0
        ? "IMPORTANT: Your previous response could not be parsed as JSON. Return ONLY a valid JSON object — no prose, no markdown fences.\n\n"
        : "";
      const res = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(
          `${jsonReminder}Extract entities and relationships from the following passage. Return JSON only.\n\n---\n${text}\n---`
        ),
      ]);
      const content = res.content;
      raw =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c: any) => c.text ?? "").join("")
            : "";
    } catch (err) {
      logger.error(
        { orgId, err: err instanceof Error ? err.message : String(err) },
        "[kg/extractor] LLM call failed"
      );
      return null; // don't retry on network/LLM errors
    }

    const parsed = parseJSON(raw);
    if (parsed) return parsed;

    if (attempt === 0) {
      logger.warn({ orgId }, "[kg/extractor] JSON parse failed on first attempt — retrying with JSON reminder");
    } else {
      logger.error({ orgId }, "[kg/extractor] JSON parse failed on retry — chunk will produce no graph data");
    }
  }
  return null;
}

// ---- Normalize a parsed extraction into KGNode[]/KGEdge[] ----

function normalizeExtraction(
  parsed: RawExtraction,
  chunk: ExtractorChunk,
  allowTemporalMetadata = false
): ExtractionResult {
  const deptIds = chunk.department_id ? [chunk.department_id] : [];
  const nodes: KGNode[] = [];
  const seenNodes = new Set<string>();

  for (const e of parsed.entities ?? []) {
    const label = normLabel(e.label);
    const entityType = normEntityType(e.entity_type);
    if (!label || !entityType) continue;

    const key = makeNodeKey(label, entityType);
    if (seenNodes.has(key)) continue;
    seenNodes.add(key);

    const description =
      typeof e.description === "string" && e.description.trim().length > 0
        ? e.description.trim().slice(0, 140)
        : null;

    const node: KGNode = {
      org_id: chunk.org_id,
      label,
      entity_type: entityType,
      department_ids: deptIds,
      visibility: chunk.visibility,
      source_documents: [chunk.document_id],
      description,
    };

    // Attach temporal_metadata for decision entities when extraction supports it
    if (allowTemporalMetadata && entityType === "decision" && e.temporal_metadata) {
      const tm = e.temporal_metadata as Record<string, unknown>;
      const temporal: TemporalMetadata = {};
      if (typeof tm.occurred_at === "string") temporal.occurred_at = tm.occurred_at;
      if (typeof tm.decision_maker === "string") temporal.decision_maker = tm.decision_maker;
      if (Array.isArray(tm.alternatives_considered))
        temporal.alternatives_considered = (tm.alternatives_considered as unknown[])
          .filter((x): x is string => typeof x === "string");
      if (typeof tm.outcome === "string") temporal.outcome = tm.outcome;
      if (typeof tm.confidence_of_date === "number")
        temporal.confidence_of_date = tm.confidence_of_date;
      if (Object.keys(temporal).length > 0) {
        node.metadata = node.metadata || {};
        node.metadata.temporal_metadata = temporal;
      }
    }

    nodes.push(node);
  }

  const nodeKeys = new Set(nodes.map((n) => `${n.label}::${n.entity_type}`));
  const edges: KGEdge[] = [];
  const seenEdges = new Set<string>();

  for (const r of parsed.relationships ?? []) {
    const sourceLabel = normLabel(r.source);
    const targetLabel = normLabel(r.target);
    const sourceType = normEntityType(r.source_entity_type);
    const targetType = normEntityType(r.target_entity_type);
    const relation =
      typeof r.relation === "string" && r.relation.trim().length > 0
        ? r.relation.trim().toUpperCase()
        : null;

    if (!sourceLabel || !targetLabel || !sourceType || !targetType || !relation) continue;
    if (!nodeKeys.has(`${sourceLabel}::${sourceType}`)) continue;
    if (!nodeKeys.has(`${targetLabel}::${targetType}`)) continue;

    const provenance = normProvenance(r.provenance);
    const confidence = normConfidence(r.confidence, provenance);

    const key = `${sourceLabel}::${sourceType}->${relation}->${targetLabel}::${targetType}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    edges.push({
      org_id: chunk.org_id,
      source_label: sourceLabel,
      source_entity_type: sourceType,
      target_label: targetLabel,
      target_entity_type: targetType,
      relation,
      provenance,
      confidence,
      source_document: chunk.document_id,
      department_id: chunk.department_id ?? null,
      visibility: chunk.visibility,
    });
  }

  return { nodes, edges };
}

// ---- Single-chunk extraction (dual-prompt) -------------------

async function extractFromChunk(
  chunk: ExtractorChunk,
  orgId: string
): Promise<ExtractionResult> {
  const systemPrompt = await loadPrompt(orgId);
  // Check both source_type and provider keys (indexing.ts stores under 'provider'; some paths use 'source_type')
  const sourceKey = (
    (chunk.metadata?.source_type ?? chunk.metadata?.provider) as string | undefined ?? ""
  ).toLowerCase();
  // Review F3: the umbrella providers (google/microsoft) added in P0-1 also cover
  // calendar events, which essentially never contain decision records — exclude
  // them by resource_type so the dual prompt doesn't double LLM cost on calendars.
  const resourceType = ((chunk.metadata?.resource_type as string | undefined) ?? "").toLowerCase();
  const NON_DECISION_RESOURCE_TYPES = new Set(["calendar_event", "event"]);
  const runDecision =
    sourceKey !== "" &&
    DECISION_SOURCE_TYPES.has(sourceKey) &&
    !NON_DECISION_RESOURCE_TYPES.has(resourceType);

  // Run general extraction; optionally run decision extraction in parallel
  const [generalParsed, decisionParsed] = await Promise.all([
    llmExtract(systemPrompt, chunk.text, orgId),
    runDecision
      ? llmExtract(DECISION_EXTRACTION_PROMPT, chunk.text, orgId)
      : Promise.resolve(null),
  ]);

  const general = generalParsed
    ? normalizeExtraction(generalParsed, chunk, false)
    : { nodes: [], edges: [] };

  const decision = decisionParsed
    ? normalizeExtraction(decisionParsed, chunk, true)
    : { nodes: [], edges: [] };

  // Merge: decision nodes/edges are additive — they introduce new decision-type nodes
  // that general extraction may not have captured. The merge in extractEntitiesAndRelations
  // handles deduplication by (org_id, label, entity_type).
  return {
    nodes: [...general.nodes, ...decision.nodes],
    edges: [...general.edges, ...decision.edges],
  };

}

// ---- Public API -----------------------------------------------

/**
 * Extract entities and relationships from a batch of chunks.
 *
 * Runs the LLM per chunk, merges results, and deduplicates nodes by
 * `(org_id, label, entity_type)` (matching the kg_nodes UNIQUE
 * constraint). When the same node appears in multiple chunks, the
 * merged record unions `department_ids` and `source_documents`.
 */
export async function extractEntitiesAndRelations(
  chunks: ExtractorChunk[],
  _supabase: SupabaseClient
): Promise<ExtractionResult> {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { nodes: [], edges: [] };
  }

  const orgId = chunks[0].org_id;

  // Running chunk LLM calls in parallel up to a small cap
  const CONCURRENCY = 5;
  const chunkResults: ExtractionResult[] = [];
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map((chunk) => extractFromChunk(chunk, orgId))
    );
    chunkResults.push(...settled);
  }

  // Merge nodes by (org_id, label, entity_type)
  const nodeMap = new Map<string, KGNode>();
  for (const res of chunkResults) {
    for (const n of res.nodes) {
      const key = `${n.org_id}::${makeNodeKey(n.label, n.entity_type)}`;
      const existing = nodeMap.get(key);
      if (!existing) {
        nodeMap.set(key, {
          ...n,
          department_ids: [...n.department_ids],
          source_documents: [...n.source_documents],
        });
      } else {
        existing.department_ids = unionStrings(
          existing.department_ids,
          n.department_ids
        );
        existing.source_documents = unionStrings(
          existing.source_documents,
          n.source_documents
        );
        // Prefer the first non-empty description; broaden visibility if needed
        if (!existing.description && n.description) existing.description = n.description;
        existing.visibility = maxVisibility(existing.visibility, n.visibility);
      }
    }
  }

  // Merge edges by (org_id, source, target, relation). Keep highest
  // confidence and strongest provenance.
  const edgeMap = new Map<string, KGEdge>();
  for (const res of chunkResults) {
    for (const e of res.edges) {
      const key = `${e.org_id}::${e.source_label}::${e.source_entity_type}->${e.relation}->${e.target_label}::${e.target_entity_type}`;
      const existing = edgeMap.get(key);
      if (!existing) {
        edgeMap.set(key, { ...e });
      } else {
        existing.provenance = strongerProvenance(existing.provenance, e.provenance);
        existing.confidence = Math.max(existing.confidence, e.confidence);
      }
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
  };
}
