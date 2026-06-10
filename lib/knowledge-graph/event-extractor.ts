// ============================================================
// event-extractor.ts — kg_events extraction (Sprint 4F)
//
// Extracts discrete events from document chunks and persists them
// to kg_events via supabaseAdmin. Uses a targeted LLM prompt to
// identify incidents, decisions, escalations, milestones, alerts,
// and changes — only for source types that commonly contain them.
//
// Runs after upsertGraph() in builder.ts so the nodeIdMap is
// available for entity → event linking.
//
// Best-effort: failure logs and returns without throwing so the
// parent build job is not disrupted.
// ============================================================

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
// SERVICE-ROLE JUSTIFICATION: background write path (kg_events upserts) run
// from builder.ts after indexing — no user RLS context exists. Event reads
// for users go through causal-chain / query paths under withRLS().
import { supabaseAdmin } from "@/lib/supabase/server";
import { resolveModelClient } from "@/lib/langgraph/llm-factory";
import { logger } from "@/lib/logger";
import type { ExtractorChunk } from "./types";

// Source types that are likely to contain events
const EVENT_SOURCE_TYPES = new Set([
  "pagerduty",
  "jira",
  "linear",
  "github",
  "zendesk",
  "intercom",
  "slack",
  "notion",
  "confluence",
  "google_drive",
  "sharepoint",
]);

const VALID_EVENT_TYPES = new Set([
  "incident",
  "decision",
  "escalation",
  "milestone",
  "alert",
  "change",
]);

const EVENT_EXTRACTION_PROMPT = `You are extracting discrete events from a document chunk for a knowledge graph.

An event is a specific thing that happened, tied to a named entity (a system, team, project, customer, or contract).

Extract events as a JSON array. Return [] if no events are found.

Schema:
[{
  "entity_label": "exact name of the entity the event is about",
  "entity_type": "incident|service|project|customer|contract|team|person",
  "event_type": "incident|decision|escalation|milestone|alert|change",
  "event_time": "ISO8601 datetime string or null if not mentioned",
  "description": "one sentence: what happened, to what, with what outcome"
}]

Rules:
- Only extract events that are explicitly stated, not implied
- entity_label must be a real named entity from the text
- event_time: extract dates like "March 15", "Q1 2024", "last Tuesday" — convert to ISO8601 best-effort, null if unclear
- description must be a single sentence under 200 characters
- Return ONLY a valid JSON array — no prose, no fences`;

type RawEvent = {
  entity_label?: unknown;
  entity_type?: unknown;
  event_type?: unknown;
  event_time?: unknown;
  description?: unknown;
};

function parseEventResponse(raw: string): RawEvent[] {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        const parsed = JSON.parse(fenced[1]);
        return Array.isArray(parsed) ? parsed : [];
      } catch {}
    }
    const arrStart = trimmed.indexOf("[");
    const arrEnd = trimmed.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd > arrStart) {
      try {
        const parsed = JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch {}
    }
    return [];
  }
}

function normaliseEventTime(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return new Date().toISOString();
  const t = raw.trim();
  // Already valid ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t;
  // Try native Date parsing as a best-effort fallback
  const d = new Date(t);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Extract events from a batch of chunks and upsert them to kg_events.
 * Silently skips source types that don't commonly produce events.
 *
 * @param chunks      ExtractorChunks for the document being processed
 * @param orgId       Organization UUID
 * @param docId       Document UUID (stored as source_document_id on each event)
 * @param nodeIdMap   label::type → node UUID map from upsertGraph()
 */
export async function extractAndUpsertEvents(
  chunks: ExtractorChunk[],
  orgId: string,
  docId: string,
  nodeIdMap: Map<string, string>
): Promise<void> {
  if (chunks.length === 0 || nodeIdMap.size === 0) return;

  // Only run on event-bearing source types
  const sourceKey = (
    (chunks[0].metadata?.source_type ?? chunks[0].metadata?.provider) as string | undefined ?? ""
  ).toLowerCase();

  if (sourceKey && !EVENT_SOURCE_TYPES.has(sourceKey)) return;

  const events: Array<{
    org_id: string;
    entity_id: string;
    event_type: string;
    event_time: string;
    description: string;
    source_document_id: string;
    confidence: number;
  }> = [];

  // Process up to 3 chunks per document to limit LLM cost
  const chunksToProcess = chunks.slice(0, 3);

  for (const chunk of chunksToProcess) {
    try {
      const llm = await resolveModelClient("simple", orgId, 0);
      const response = await llm.invoke([
        new SystemMessage(EVENT_EXTRACTION_PROMPT),
        new HumanMessage(
          `Extract events from this text. Return JSON array only.\n\n---\n${chunk.text.slice(0, 3000)}\n---`
        ),
      ]);

      const text =
        typeof response.content === "string"
          ? response.content
          : Array.isArray(response.content)
          ? (response.content as any[]).map((c: any) => c.text ?? "").join("")
          : "";

      const rawEvents = parseEventResponse(text);

      for (const ev of rawEvents) {
        if (typeof ev.entity_label !== "string" || !ev.entity_label.trim()) continue;
        if (typeof ev.event_type !== "string") continue;
        if (typeof ev.description !== "string" || !ev.description.trim()) continue;

        const eventType = ev.event_type.toLowerCase();
        if (!VALID_EVENT_TYPES.has(eventType)) continue;

        const entityLabel = ev.entity_label.trim().toLowerCase();
        const entityType = typeof ev.entity_type === "string" ? ev.entity_type.trim().toLowerCase() : "";

        // Try to match to a known node — try exact label::type first, then label-only
        let entityId: string | undefined;
        if (entityType) {
          entityId = nodeIdMap.get(`${entityLabel}::${entityType}`);
        }
        if (!entityId) {
          // Search all map entries for a label prefix match
          for (const [key, id] of nodeIdMap) {
            if (key.startsWith(`${entityLabel}::`)) {
              entityId = id;
              break;
            }
          }
        }

        if (!entityId) continue; // skip events for unknown entities

        events.push({
          org_id: orgId,
          entity_id: entityId,
          event_type: eventType,
          event_time: normaliseEventTime(ev.event_time),
          description: String(ev.description).slice(0, 300),
          source_document_id: docId,
          confidence: 0.9,
        });
      }
    } catch (err) {
      logger.warn(
        { orgId, docId, err: err instanceof Error ? err.message : String(err) },
        "[event-extractor] Chunk extraction failed — skipping"
      );
    }
  }

  if (events.length === 0) return;

  // Deduplicate by (entity_id, event_type, event_time) before insert
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    const key = `${e.entity_id}|${e.event_type}|${e.event_time.slice(0, 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { error } = await supabaseAdmin.from("kg_events").insert(unique);
  if (error) {
    logger.warn(
      { orgId, docId, err: error.message, count: unique.length },
      "[event-extractor] kg_events insert failed"
    );
  } else {
    logger.info(
      { orgId, docId, count: unique.length },
      "[event-extractor] Events upserted"
    );
  }
}
