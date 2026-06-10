import { AtheneStateType } from "../state";
import { z } from "zod";
import { resolveModelClient } from "../llm-factory";
import { logger } from "@/lib/logger";

const MAX_HOPS = 6;

// FROZEN (REFOCUS §3.1/§3.2): email_agent, calendar_agent, report_agent removed
// from routing — the assistant is read-only for external writes. Restore behind
// WRITE_ACTIONS_ENABLED when write actions return (Phase 2+).
// watchlist_agent is NOT frozen — it creates internal Athene watchlists.
const ALL_AGENTS = [
  "planner",
  "retrieval",
  "cross_dept_retrieval",
  "integration_agent",
  "diff_agent",
  "watchlist_agent",
  "synthesis",
  "END",
] as const;

const supervisorPrompt = `You are the supervisor of an AI assistant. Route the conversation to the correct specialized agent.

**USER ROLE:** {user_role}
**HOPS REMAINING:** {hops_left}
**RETRIEVAL STATUS:** {retrieval_status}

## Available Agents

- planner: Decompose a complex multi-department query into sequential retrieval steps. Use ONLY on the first hop when the question clearly spans 2+ departments (e.g. "How does the AWS incident affect Q2 revenue and our SLA with Acme?").
- retrieval: Search documents within the user's organization (Jira, Confluence, Slack, email, calendar, etc.). All questions ABOUT email or calendar content go here.
- cross_dept_retrieval: Cross-department BI analysis — revenue insights, multi-team trends. **Restricted: super_user and admin roles only.**
- integration_agent: Read-only integration info — list connected integrations or check sync status. Route here when the user asks about integrations, connected apps, or data sources. (Connecting, disconnecting, and re-syncing happen in the settings UI, not in chat.)
- diff_agent: Compare two time windows and report what changed. Route here when the user asks "what changed since [date/period]", "what's new this week/month", "what happened while I was away", or any before/after comparison over time. The diff agent answers completely on its own — do NOT route to retrieval first.
- watchlist_agent: Create a watchlist — a standing query Athene monitors and alerts the user when the answer changes. Route here when the user says "watch this", "keep an eye on X", "alert me when Y changes", "monitor X for me", or "create a watchlist for Z". The watchlist_agent proposes the watchlist and asks for confirmation — route here immediately, do not retrieve first.
- synthesis: Synthesize a final answer from accumulated retrieved context and finish.
- END: The request has been fully answered — stop the graph.

This assistant is READ-ONLY for external systems: it cannot send emails or create calendar events. Watchlist creation (internal Athene feature) IS supported via watchlist_agent.

## Routing Rules

1. **Role guard**: member roles MUST NOT be routed to cross_dept_retrieval. Route to retrieval instead.
2. **Hop guard**: If hops_left <= 1, route to synthesis or END to avoid hitting the hop limit.
3. **Synthesis trigger**: Judge sufficiency from RETRIEVAL STATUS. Route to synthesis when retrieval looks sufficient (several chunks, decent similarity scores, query terms covered). Route to retrieval again ONLY if the status shows sparse results or poor coverage of the question AND hops remain — rephrase expectations, don't loop on the same hope. Never route to retrieval more than twice for the same question.
4. **END condition**: Route to END only after the final answer has already been delivered.
5. **Agent specificity**: Choose the most targeted agent; avoid unnecessary retrieval hops.
6. **Planner guard**: Only route to planner on the very first hop (hops_remaining = MAX) and only when the question clearly spans 2+ departments. Never re-route to planner on subsequent hops.
7. **Temporal diff**: "What changed since X" / "what's new this week" questions go to diff_agent, not retrieval. diff_agent is terminal — it delivers the final answer itself.
8. **Watchlist guard**: "Watch this", "monitor X", "alert me when Y" go to watchlist_agent immediately. Never route to retrieval first — the agent extracts the query from context itself.`;

// Common stopwords excluded from query-term coverage measurement
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "from",
  "what", "when", "where", "which", "who", "how", "why", "did", "does", "has",
  "have", "had", "about", "into", "over", "under", "between", "your", "our",
  "their", "them", "they", "you", "any", "all", "can", "could", "would",
  "should", "tell", "show", "find", "give", "please", "there", "been",
]);

/**
 * Summarize retrieval state into a sufficiency signal for the routing LLM
 * (REFOCUS §5.6): chunk count, top similarity scores, and how many of the
 * query's meaningful terms appear in the retrieved text. Replaces the old
 * hard "≥2 chunks → synthesis" guard, which synthesized prematurely on two
 * low-relevance hits and starved multi-faceted questions of further hops.
 */
function summarizeRetrieval(state: AtheneStateType): string {
  const chunks = state.retrieved_chunks ?? [];
  if (chunks.length === 0) return "No chunks retrieved yet.";

  const scores = chunks
    .map((c: any) => (typeof c.similarity === "number" ? c.similarity : null))
    .filter((s): s is number => s !== null)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .map((s) => s.toFixed(2));

  const lastHuman = [...state.messages]
    .reverse()
    .find((m) => m._getType?.() === "human");
  const queryText =
    typeof lastHuman?.content === "string" ? lastHuman.content.toLowerCase() : "";
  const terms = Array.from(
    new Set(
      queryText
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
    )
  );

  let coverage = "";
  if (terms.length > 0) {
    const haystack = chunks
      .map((c: any) => `${c.content_preview ?? ""}`)
      .join(" ")
      .toLowerCase();
    const covered = terms.filter((t) => haystack.includes(t)).length;
    coverage = `; query-term coverage ${covered}/${terms.length}`;
  }

  const scorePart = scores.length > 0 ? `; top similarity scores [${scores.join(", ")}]` : "";
  return `${chunks.length} chunk(s) retrieved${scorePart}${coverage}.`;
}

/**
 * Supervisor node that routes queries to the appropriate specialist.
 */
export async function supervisor(state: AtheneStateType) {
  const hopCount = state.hop_count ?? 0;

  // ── HITL resume guard ──────────────────────────────────────────────────────
  // After a user approves an action, the approve endpoint sets
  // awaiting_approval=false while leaving pending_write_action populated.
  // When graph.stream() resumes from the checkpoint, LangGraph re-enters at
  // START → supervisor. We must NOT ask the LLM to re-route here — it has no
  // concept of "an action just got approved". Instead, bypass the LLM and
  // route directly to action_executor so the payload is executed exactly once.
  // action_executor clears pending_write_action when done, so a second resume
  // would fall through to normal routing.
  if (!state.awaiting_approval && state.pending_write_action) {
    return {
      next_node: "action_executor",
      reasoning: "[Guard] Approved write action pending execution → action_executor (bypass LLM).",
      hop_count: hopCount,
    };
  }

  // ── Hop-limit guard: skip LLM entirely at max hops ──
  if (hopCount >= MAX_HOPS) {
    return {
      next_node: "END",
      reasoning: `[Guard] Max hop limit (${MAX_HOPS}) reached.`,
      hop_count: hopCount,
    };
  }

  const userRole = state.role ?? "member";
  const hopsLeft = MAX_HOPS - hopCount;

  const responseSchema = z.object({
    next_agent: z.enum(ALL_AGENTS),
    task_type: z.string(),
    complexity: z.string(),
    reasoning: z.string(),
  });

  const systemContent = supervisorPrompt
    .replace("{user_role}", String(userRole))
    .replace("{hops_left}", String(hopsLeft))
    .replace("{retrieval_status}", summarizeRetrieval(state));

  // Use functionCalling method — DeepSeek supports tool calls but not json_schema
  // response_format, which is what the default withStructuredOutput sends.
  const structuredModel = (
    await resolveModelClient("medium", state.orgId)
  ).withStructuredOutput(responseSchema, { method: "functionCalling" });

  const response = await structuredModel.invoke([
    { role: "system", content: systemContent },
    ...state.messages,
  ]);

  let nextAgent = response.next_agent;
  let taskType = response.task_type;
  let isCrossDeptQuery = state.is_cross_dept_query ?? false;
  let reasoning = response.reasoning;

  // ── Role guard: members cannot use cross_dept_retrieval ──
  if (nextAgent === "cross_dept_retrieval" && userRole === "member") {
    nextAgent = "retrieval";
    taskType = "document_search";
    isCrossDeptQuery = false;
    reasoning = `[Guard] member role blocked from cross_dept_retrieval → routed to retrieval. (${reasoning})`;
  }

  // ── Planner guard: only allow planner on first hop, never loop back ──
  if (nextAgent === "planner" && hopCount > 0) {
    nextAgent = "retrieval";
    reasoning = `[Guard] Planner only runs on first hop — routing to retrieval. (${reasoning})`;
  }

  // ── Hop-left guard: force synthesis/END when nearly out of hops ──
  if (hopsLeft <= 1 && nextAgent !== "synthesis" && nextAgent !== "END") {
    nextAgent = "synthesis";
    taskType = "synthesis";
    reasoning = `[Guard] Only ${hopsLeft} hop(s) left → forced to synthesis. (${reasoning})`;
  }

  return {
    next_node: nextAgent === "END" ? "END" : nextAgent,
    task_type: taskType,
    complexity: response.complexity,
    reasoning,
    hop_count: hopCount + 1,
    is_cross_dept_query:
      nextAgent === "cross_dept_retrieval" ? true : isCrossDeptQuery,
  };
}
