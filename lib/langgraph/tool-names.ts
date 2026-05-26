/**
 * Canonical tool name constants used across agents and action-executor.
 * Using constants prevents typos in string comparisons scattered across
 * agent files, action-executor switch/if branches, and test assertions.
 */
export const TOOL_NAMES = {
  EMAIL_SEND: 'email-send',
  CALENDAR_CREATE: 'calendar-create',
  INTEGRATION_CONNECT: 'integration-connect',
  INTEGRATION_DISCONNECT: 'integration-disconnect',
} as const

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES]

/**
 * Build the standard HITL approval state update.
 * All agents that pause for user confirmation follow this shape.
 */
export function buildApprovalUpdate(
  tool: ToolName | string,
  payload: Record<string, unknown>,
): { run_status: string; awaiting_approval: true; pending_write_action: { tool: string; payload: Record<string, unknown>; requested_at: string } } {
  return {
    run_status: 'awaiting_approval',
    awaiting_approval: true,
    pending_write_action: {
      tool,
      payload,
      requested_at: new Date().toISOString(),
    },
  }
}
