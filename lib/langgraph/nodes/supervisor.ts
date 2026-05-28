import { AtheneStateType } from "../state";
import { z } from "zod";
import { resolveModelClient } from "../llm-factory";
import { logger } from "@/lib/logger";

const MAX_HOPS = 6;

const ALL_AGENTS = [
  "planner",
  "retrieval",
  "cross_dept_retrieval",
  "email_agent",
  "calendar_agent",
  "integration_agent",
  "action_executor",
  "report_agent",
  "synthesis",
  "END",
] as const;

const supervisorPrompt = `You are the supervisor of an AI assistant. Route the conversation to the correct specialized agent.

**USER ROLE:** {user_role}
**HOPS REMAINING:** {hops_left}

## Available Agents

- planner: Decompose a complex multi-department query into sequential retrieval steps. Use ONLY on the first hop when the question clearly spans 2+ departments (e.g. "How does the AWS incident affect Q2 revenue and our SLA with Acme?").
- retrieval: Search documents within the user's organization (Jira, Confluence, Slack, SharePoint, etc.)
- cross_dept_retrieval: Cross-department BI analysis — revenue insights, multi-team trends. **Restricted: super_user and admin roles only.**
- email_agent: Draft or send an email. Use ONLY when the user explicitly asks to compose, write, send, or reply to an email. Do NOT use for reading, searching, or asking questions about email content.
- calendar_agent: Read calendar, find free slots, or create events.
- integration_agent: Manage data source connections — list connected integrations, connect a new provider (Google Drive, Slack, Notion, etc.), disconnect a source, check sync status, or trigger a re-sync. Route here when the user asks about integrations, connected apps, or data sources.
- action_executor: Execute approved write actions (emails, calendar events, integration connect/disconnect).
- report_agent: Plan and write structured, multi-section reports using vectorized and graph data.
- synthesis: Synthesize a final answer from accumulated retrieved context and finish.
- END: The request has been fully answered — stop the graph.

## Routing Rules

1. **Role guard**: member roles MUST NOT be routed to cross_dept_retrieval. Route to retrieval instead.
2. **Hop guard**: If hops_left <= 1, route to synthesis or END to avoid hitting the hop limit.
3. **Synthesis trigger**: Route to synthesis when enough information has been gathered.
4. **END condition**: Route to END only after the final answer has already been delivered.
5. **Agent specificity**: Choose the most targeted agent; avoid unnecessary retrieval hops.
6. **Planner guard**: Only route to planner on the very first hop (hops_remaining = MAX) and only when the question clearly spans 2+ departments. Never re-route to planner on subsequent hops.
7. **Email read vs write**: Questions about email content ("what emails", "anything in gmail", "did someone email about X") → retrieval. Only route to email_agent when the user explicitly wants to COMPOSE or SEND a new email (e.g. "write an email to...", "send a message to...", "draft a reply to...").`;

/**
 * Supervisor node that routes queries to the appropriate specialist.
 */
export async function supervisor(state: AtheneStateType) {
  const hopCount = state.hop_count ?? 0;

  // ── Hop-limit guard: skip LLM entirely at max hops ──
  if (hopCount >= MAX_HOPS) {
    return {
      next_node: "END",
      reasoning: `[Guard] Max hop limit (${MAX_HOPS}) reached.`,
      hop_count: hopCount,
    };
  }

  // ── Retrieval-complete guard: synthesize once we have enough chunks ──
  // Require at least 2 chunks so a single low-relevance hit doesn't prematurely
  // end retrieval. The LLM cannot see retrieved_chunks in state, so without this
  // guard it would loop; with it, multi-hop retrieval still works for sparse queries.
  if ((state.retrieved_chunks?.length ?? 0) >= 2 && hopCount > 0) {
    return {
      next_node: "synthesis",
      task_type: "synthesis",
      complexity: state.complexity ?? "standard",
      reasoning: `[Guard] ${state.retrieved_chunks!.length} chunk(s) retrieved → routing to synthesis`,
      hop_count: hopCount + 1,
      is_cross_dept_query: state.is_cross_dept_query ?? false,
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
    .replace("{hops_left}", String(hopsLeft));

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

  // ── Email read guard: email_agent is write-only (draft/send).
  // Any question ABOUT email content must go to retrieval (emails are indexed in vector DB).
  // Only explicit compose/send intent should reach email_agent.
  if (nextAgent === "email_agent") {
    const lastMsg = state.messages[state.messages.length - 1];
    const text = (typeof lastMsg?.content === "string" ? lastMsg.content : "").toLowerCase();
    const writeIntent = /\b(send|draft|write|compose|reply|respond|email to|message to)\b/.test(text);
    if (!writeIntent) {
      nextAgent = "retrieval";
      taskType = "document_search";
      reasoning = `[Guard] email_agent requires explicit send/compose intent — routed to retrieval. (${reasoning})`;
    }
  }

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
