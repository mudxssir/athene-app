// ============================================================
// lib/langgraph/nodes/integration-agent.ts
//
// LangGraph node wrapper for the integration management agent.
// Follows the same thin-wrapper pattern as email-agent.ts.
//
// Registered in lib/langgraph/graph.ts as "integration_agent" node.
// Routed by supervisor when user asks about integrations.
// ============================================================

import type { AtheneState, AtheneStateUpdate } from '../state'
import { integrationAgentNode as implementation } from '@/lib/agents/integration-agent'

/**
 * Integration agent node — manages data source connections conversationally.
 *
 * Delegates to lib/agents/integration-agent. For "connect" and "disconnect"
 * actions, sets `pending_write_action` and `awaiting_approval=true`;
 * graph pauses until the user approves via POST /api/agent/approve.
 *
 * For "list", "status", and "sync" actions, returns an AIMessage directly
 * without requiring approval.
 *
 * @param state - Current LangGraph thread state
 * @returns State update (may include pending_write_action for HITL gate)
 */
export async function integrationAgentNode(
  state: AtheneState,
): Promise<AtheneStateUpdate> {
  return implementation(state)
}
