// ============================================================
// nodes/watchlist-agent.ts — "Watch this" HITL node (REFOCUS §6.4)
//
// Routes to this node when the user says "watch X", "monitor Y",
// "alert me when Z changes", or "keep an eye on this".
//
// Extracts a proposed name + query from the user's message,
// returns buildApprovalUpdate() so the user confirms before
// the watchlist is created. The action-executor handles the
// actual POST /api/watchlists on approval.
//
// This is an internal Athene action (not a frozen external write).
// ============================================================

import { AIMessage } from "@langchain/core/messages"
import type { AtheneState, AtheneStateUpdate } from "../state"
import { resolveModelClient } from "../llm-factory"
import { buildApprovalUpdate, TOOL_NAMES } from "../tool-names"
import { logger } from "@/lib/logger"

const DEFAULT_SCHEDULE = "0 */6 * * *"

function lastUserMessage(state: AtheneState): string {
  const msgs = [...(state.messages ?? [])]
  const last = msgs.reverse().find((m) => m._getType?.() === "human")
  return typeof last?.content === "string" ? last.content : ""
}

export async function watchlistAgentNode(state: AtheneState): Promise<AtheneStateUpdate> {
  try {
    const userMsg = lastUserMessage(state)
    const llm = await resolveModelClient("fast", state.orgId)

    const extractionPrompt = `The user wants to create a watchlist in Athene — a standing query that fires alerts when the answer changes.

USER MESSAGE: "${userMsg}"

Extract:
1. name: a short watchlist name (≤80 chars) that captures what's being monitored
2. query: the standing question Athene should monitor (≤400 chars, phrased as a question)
3. schedule: one of "0 * * * *" (hourly), "0 */6 * * *" (every 6h, default), "0 9 * * *" (daily 9am), "0 9 * * 1-5" (weekdays)

Respond ONLY with compact JSON: {"name":"...","query":"...","schedule":"..."}`

    let name = "New Watchlist"
    let query = userMsg.slice(0, 400)
    let schedule = DEFAULT_SCHEDULE

    try {
      const res = await llm.invoke(extractionPrompt)
      const text = typeof res.content === "string" ? res.content : String(res.content)
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (typeof parsed.name === "string" && parsed.name.trim()) name = parsed.name.trim()
        if (typeof parsed.query === "string" && parsed.query.trim()) query = parsed.query.trim()
        if (typeof parsed.schedule === "string") schedule = parsed.schedule
      }
    } catch {
      // Fall back to defaults if extraction fails
    }

    const approval = buildApprovalUpdate(TOOL_NAMES.WATCHLIST_CREATE, { name, query, schedule })

    return {
      ...approval,
      messages: [
        new AIMessage({
          content: [
            `I'll set up a watchlist to monitor this for you.`,
            ``,
            `**Name:** ${name}`,
            `**Query:** *${query}*`,
            `**Frequency:** ${schedule === "0 * * * *" ? "Hourly" : schedule === "0 */6 * * *" ? "Every 6 hours" : schedule === "0 9 * * *" ? "Daily at 9am" : "Weekdays at 9am"}`,
            ``,
            `Confirm to create it, or cancel to adjust the query.`,
          ].join("\n"),
        }),
      ],
    }
  } catch (err) {
    logger.error({ err, orgId: state.orgId }, "[watchlist-agent] Failed to extract watchlist params")
    return {
      messages: [
        new AIMessage({
          content: "I had trouble setting up the watchlist. Please try again or head to Watchlists to create one manually.",
        }),
      ],
    }
  }
}
