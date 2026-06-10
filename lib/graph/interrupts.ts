// ============================================================
// graph/interrupts.ts — HITL approval gate logic (ATH-43)
//
// Handles the approve / edit / reject flow for write actions
// that are paused at the interrupt_before gate.
//
// Flow:
//   1. email_agent or calendar_agent sets awaiting_approval=true
//      and populates pending_write_action.
//   2. Graph pauses because approval_node has interrupt_before.
//   3. Frontend shows the draft to the user.
//   4. User calls POST /api/threads/[id]/approve with their decision.
//   5. This module validates ownership, logs the decision, and
//      updates the checkpoint state before resuming the graph.
//
// Rule #4: No writes without explicit human approval.
// ============================================================

import { supabaseAdmin } from "../supabase/server";
import type { PendingWriteAction } from "../langgraph/state";
import { logger } from "../logger";
import { z } from "zod";


export const emailDraftSchema = z.object({
  to: z.array(z.string().email()).min(1, "At least one recipient is required"),
  cc: z.array(z.string().email()).default([]),
  subject: z.string().trim().min(1, "Subject is required"),
  body: z.string().trim().min(1, "Body is required"),
  _warning: z.string().optional(),
});

// Allowed cron schedules for watchlists — must stay in sync with
// the SCHEDULES array in components/watchlists/watchlist-create.tsx.
// Rejecting arbitrary strings here closes a stored-XSS / cron-injection
// vector where an LLM-extracted schedule goes directly to the DB.
export const ALLOWED_WATCHLIST_SCHEDULES = [
  "0 * * * *",    // Every hour
  "0 */6 * * *",  // Every 6 hours
  "0 9 * * *",    // Daily 9am
  "0 6 * * *",    // Daily 6am
  "0 9 * * 1-5",  // Weekdays 9am
] as const;

export const watchlistCreateSchema = z.object({
  name: z.string().trim().min(1, "Watchlist name is required").max(120, "Name too long"),
  query: z.string().trim().min(1, "Watchlist query is required").max(1000, "Query too long"),
  schedule: z.enum(ALLOWED_WATCHLIST_SCHEDULES, {
    error: `Schedule must be one of: ${ALLOWED_WATCHLIST_SCHEDULES.join(", ")}`,
  }).optional().default("0 */6 * * *"),
});

// ---- Types ---------------------------------------------------


export type HitlAction = "approve" | "edit" | "reject";

export interface HitlRequest {
  action: HitlAction;
  /** Required when action === "edit" — the corrected payload fields */
  edits?: Record<string, unknown>;
}

export interface HitlResult {
  approved: boolean;
  /** The final payload to execute (original or edited) */
  payload: Record<string, unknown> | null;
}

// ---- Validation ----------------------------------------------

/**
 * Validates a pending action payload against the appropriate tool schema.
 * Throws if validation fails.
 */
export async function validatePayload(
  tool: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    if (tool === "email-send") {
      emailDraftSchema.parse(payload);
    } else if (tool === "calendar-create") {
      const { calendarEventSchema } = await import("@/lib/agents/calendar-agent");
      calendarEventSchema.parse(payload);
    } else if (tool === "watchlist-create") {
      watchlistCreateSchema.parse(payload);
    }
  } catch (err: any) {
    const detail = err instanceof z.ZodError ? err.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') : err.message;
    logger.warn({ tool, detail }, "Payload validation failed");
    throw new Error(`Draft validation failed: ${detail}`);
  }
}


// ---- Thread ownership check ----------------------------------

/**
 * Verify that the requesting user owns the thread.
 * Returns the thread row or null if unauthorized.
 */
export async function verifyThreadOwner(
  threadId: string,
  userId: string,
  orgId: string,
): Promise<{ id: string; user_id: string; org_id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("threads")
    .select("id, user_id, org_id")
    .eq("id", threadId)
    .eq("org_id", orgId)
    .single();

  if (error || !data) return null;

  // Only the thread owner can approve their own actions
  if (data.user_id !== userId) return null;

  return data as { id: string; user_id: string; org_id: string };
}

// ---- Decision processing -------------------------------------

/**
 * Process a HITL decision and return the state updates to apply
 * before resuming the graph.
 */
export function processDecision(
  request: HitlRequest,
  pendingAction: PendingWriteAction,
): HitlResult {
  switch (request.action) {
    case "approve":
      return {
        approved: true,
        payload: pendingAction.payload,
      };

    case "edit":
      if (!request.edits || Object.keys(request.edits).length === 0) {
        throw new Error("Edit action requires non-empty edits object");
      }
      // Only merge fields that are present in the original payload to prevent injection of unknown keys
      const filteredEdits: Record<string, unknown> = {};
      for (const key of Object.keys(request.edits)) {
        if (key in pendingAction.payload) {
          filteredEdits[key] = request.edits[key];
        }
      }

      return {
        approved: true,
        payload: { ...pendingAction.payload, ...filteredEdits },
      };

    case "reject":
      return {
        approved: false,
        payload: null,
      };

    default:
      throw new Error(`Invalid HITL action: ${request.action}`);
  }
}

// ---- Audit logging -------------------------------------------

/**
 * Write a row to the hitl_decisions table for every approval decision.
 * This is a hard requirement — every decision must be audit-logged.
 */
export async function logHitlDecision(params: {
  orgId: string;
  threadId: string;
  userId: string;
  actionType: string;
  decision: HitlAction;
  originalPayload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("hitl_decisions").insert({
    org_id: params.orgId, // Must be UUID
    thread_id: params.threadId,
    user_id: params.userId,
    action_type: params.actionType,
    decision: params.decision === "approve" ? "approved"
      : params.decision === "edit" ? "edited"
      : "rejected",
    original_payload: params.originalPayload,
    edited_payload: params.editedPayload,
  });

  if (error) {
    logger.error({ error: error.message, threadId: params.threadId }, "[hitl] Audit log insertion failed — blocking action");
    throw new Error(`Audit logging failed: ${error.message}. Action blocked for safety.`);
  }
}
