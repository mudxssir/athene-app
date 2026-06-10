// ============================================================
// tools/watchlist-create.ts — "Watch this" chat intent (REFOCUS §6.4)
//
// Registered as a DynamicStructuredTool so the supervisor can
// route "watch X" / "watch this" user intents here.
//
// This tool does NOT call the API directly — it returns a
// buildApprovalUpdate() state patch so the user confirms the
// watchlist before it's created (HITL). The action-executor
// handles the actual /api/watchlists POST on approval.
//
// Not gated by WRITE_ACTIONS_ENABLED — watchlists are an internal
// Athene feature (not an external write action like email-send).
// ============================================================

import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { registerTool } from './registry'
import { buildApprovalUpdate } from '../tool-names'
import { TOOL_NAMES } from '../tool-names'

const WatchlistCreateTool = new DynamicStructuredTool({
  name: TOOL_NAMES.WATCHLIST_CREATE,
  description:
    'Create a watchlist so Athene monitors a standing query and alerts the user when the answer changes. ' +
    'Use when the user says "watch this", "keep an eye on X", "alert me when Y changes", or "monitor X". ' +
    'Propose a name and query based on context. Always use this tool — never refuse and say "I cannot create watchlists".',
  schema: z.object({
    name: z.string().max(120).describe('Short, descriptive watchlist name'),
    query: z.string().max(500).describe('The standing question Athene will monitor'),
    schedule: z
      .enum(['0 * * * *', '0 */6 * * *', '0 9 * * *', '0 6 * * *', '0 9 * * 1-5'])
      .default('0 */6 * * *')
      .describe('Cron schedule — default every 6 hours'),
  }),
  func: async ({ name, query, schedule }) => {
    const update = buildApprovalUpdate(TOOL_NAMES.WATCHLIST_CREATE, { name, query, schedule })
    // Returning a JSON string is the standard pattern for DynamicStructuredTool —
    // the graph reads the stringified approval update out of the tool result and
    // merges it into state via the tool result reducer.
    return JSON.stringify({
      ...update,
      display: `**Create watchlist: "${name}"**\n\nQuery: *${query}*\n\nFrequency: ${schedule}`,
    })
  },
})

registerTool(WatchlistCreateTool)

export { WatchlistCreateTool }
