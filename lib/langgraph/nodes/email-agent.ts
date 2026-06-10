// FROZEN (REFOCUS §3.1/§3.2): not wired into graph routing — the assistant is
// read-only in Phase 1. Kept intact for reversibility; unfreeze via WRITE_ACTIONS_ENABLED.
import type { AtheneState, AtheneStateUpdate } from "../state";
import { emailAgentNode as implementation } from "@/lib/agents/email-agent";

/**
 * Email agent node — drafts an email action for HITL approval.
 *
 * Delegates to lib/agents/email-agent. Sets `pending_write_action` with
 * tool="email-send" and `awaiting_approval=true`; graph pauses here until
 * the user approves via POST /api/agent/approve. Actual send occurs in
 * actionExecutorNode after approval.
 *
 * @param state - Current LangGraph thread state
 * @returns State update with pending_write_action and awaiting_approval=true
 */
export async function emailAgentNode(
  state: AtheneState,
): Promise<AtheneStateUpdate> {
  return implementation(state);
}
