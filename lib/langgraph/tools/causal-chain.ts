// ============================================================
// lib/langgraph/tools/causal-chain.ts — Event timeline tool (Sprint 4F)
//
// Queries kg_events to retrieve chronological event sequences
// for a named entity. Use for incident timelines, decision
// histories, or causal chain analysis across departments.
//
// All reads run inside withRLS() — org isolation and node/event
// visibility are enforced by Postgres policies (REFOCUS §5.1).
// ============================================================

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
import { logger } from "@/lib/logger";
import { resolveEntity } from "@/lib/knowledge-graph/entity-resolver";

export const causalChainTool = new DynamicStructuredTool({
  name: "causalChain",
  description:
    "Retrieve a chronological event chain for a named entity (service, project, customer, contract). " +
    "Use for incident timelines, decision histories, escalation sequences, or causal analysis " +
    "questions like 'what happened to X' or 'trace the history of Y'.",
  schema: z.object({
    entityLabel: z
      .string()
      .describe("The entity name to look up events for (e.g. 'AWS EKS', 'Acme Corp', 'MSA Contract')"),
    maxEvents: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of events to return"),
    eventTypes: z
      .array(z.string())
      .optional()
      .describe("Filter by event types: incident, decision, escalation, milestone, alert, change"),
  }),
  func: async ({ entityLabel, maxEvents = 20, eventTypes }, _runManager, config) => {
    const cfg = (config as any)?.configurable ?? (config as any)?.metadata ?? {};
    const orgId: string = cfg.orgId ?? "";
    const userId: string = cfg.userId ?? "";
    const role: string = cfg.role ?? "member";
    const deptId: string | null = cfg.deptId ?? null;

    if (!orgId || !userId) {
      return JSON.stringify({ error: "Missing org context for causal chain lookup." });
    }

    const ctx: RLSContext = {
      org_id: orgId,
      user_id: userId,
      user_role: role as RLSContext["user_role"],
      department_id: deptId ?? undefined,
    };

    try {
      const candidates = await resolveEntity(ctx, entityLabel);
      if (candidates.length === 0) {
        return JSON.stringify({ error: `Entity "${entityLabel}" not found in knowledge graph.` });
      }

      const top = candidates[0];
      if (candidates.length > 1) {
        logger.info(
          { entityLabel, top: top.label, second: candidates[1].label, sim: top.similarity },
          "[causal-chain] Multiple entity candidates — using top match"
        );
      }

      return await withRLS(ctx, async (supabase) => {
        const { data: node, error: nodeErr } = await supabase
          .from("kg_nodes")
          .select("id, label, entity_type")
          .eq("id", top.canonicalNodeId)
          .eq("org_id", orgId)
          .maybeSingle();

        if (nodeErr) {
          logger.error({ err: nodeErr.message, entityLabel }, "[causal-chain] Node fetch failed");
          return JSON.stringify({ error: `Node fetch failed: ${nodeErr.message}` });
        }
        if (!node) {
          return JSON.stringify({ error: `Entity "${entityLabel}" not found in knowledge graph.` });
        }

        let eventsQuery = supabase
          .from("kg_events")
          .select(
            "id, event_type, event_time, description, caused_by_event_id, metadata, confidence, source_document_id"
          )
          .eq("org_id", orgId)
          .eq("entity_id", node.id)
          .order("event_time", { ascending: true })
          .limit(maxEvents);

        if (eventTypes && eventTypes.length > 0) {
          eventsQuery = eventsQuery.in("event_type", eventTypes);
        }

        const { data: events, error: eventsErr } = await eventsQuery;

        if (eventsErr) {
          logger.warn({ err: eventsErr.message }, "[causal-chain] Events query failed");
          return JSON.stringify({ error: `Events query failed: ${eventsErr.message}` });
        }

        return JSON.stringify({
          entity: { id: node.id, label: node.label, type: node.entity_type },
          events: events ?? [],
          count: events?.length ?? 0,
        });
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "[causal-chain] Unexpected error");
      return JSON.stringify({ error: "Causal chain lookup failed." });
    }
  },
});
