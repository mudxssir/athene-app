// ============================================================
// lib/langgraph/nodes/integration-agent.ts
//
// LangGraph node wrapper for the integration management agent.
// Follows the same thin-wrapper pattern as email-agent.ts.
//
// ISOLATION: This node is not registered in graph.ts yet.
// To wire it in, add to graph.ts:
//
//   import { integrationAgentNode } from "./nodes/integration-agent"
//
//   // In the StateGraph builder:
//   .addNode("integration_agent", integrationAgentNode)
//   .addEdge("integration_agent", "supervisor")
//
//   // In the conditional edges map:
//   { ..., integration_agent: "integration_agent" }
//
// And add to supervisor.ts ALL_AGENTS:
//   "integration_agent",
//
// And add to the supervisor prompt:
//   "- integration_agent: Manage data source connections — list,
//      connect, disconnect, check sync status, trigger re-sync.
//      Route here when the user asks about integrations, data
//      sources, or connecting/disconnecting services."
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
