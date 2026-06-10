// FROZEN (REFOCUS §3.1/§3.2): not wired into graph routing — the assistant is
// read-only in Phase 1. Kept intact for reversibility; unfreeze via WRITE_ACTIONS_ENABLED.
import type { AtheneState, AtheneStateUpdate } from "../state";
import { calendarAgent as implementation } from "@/lib/agents/calendar-agent";

/**
 * Calendar agent node — drafts a calendar event for HITL approval.
 *
 * Delegates to lib/agents/calendar-agent. Sets `pending_write_action` with
 * tool="calendar-create" and `awaiting_approval=true`; graph pauses until
 * the user approves via POST /api/agent/approve. Actual event creation
 * occurs in actionExecutorNode after approval.
 *
 * @param state - Current LangGraph thread state
 * @returns State update with pending_write_action and awaiting_approval=true
 */
export async function calendarAgentNode(
  state: AtheneState,
): Promise<AtheneStateUpdate> {
  return implementation(state);
}
