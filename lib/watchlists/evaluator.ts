/**
 * Runs a watchlist query through the LangGraph agent and returns
 * the final answer + cited sources. Designed for background worker use —
 * collects the full stream to extract the final state.
 */
import crypto from "crypto";
import { HumanMessage } from "@langchain/core/messages";
import { getAgentGraph } from "@/lib/langgraph/graph";
import type { EvaluationResult, WatchlistRunContext } from "./types";

const WATCHLIST_THREAD_PREFIX = "watchlist-";

/** Deterministic thread ID per watchlist so the checkpointer doesn't accumulate garbage */
function threadId(watchlistId: string): string {
  return `${WATCHLIST_THREAD_PREFIX}${watchlistId}`;
}

/** Normalise answer text before hashing: collapse whitespace, lowercase */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function hashAnswer(answer: string): string {
  return crypto.createHash("sha256").update(normalise(answer)).digest("hex");
}

export async function evaluateWatchlist(
  watchlistId: string,
  query: string,
  ctx: WatchlistRunContext,
): Promise<EvaluationResult> {
  const graph = await getAgentGraph();

  const initialState = {
    messages: [new HumanMessage(query)],
    orgId: ctx.orgId,
    userId: ctx.userId,
    role: ctx.role,
    deptId: ctx.deptId,
    user: { id: ctx.userId, timezone: ctx.userTimezone },
    task_type: "general" as const,
    is_cross_dept_query: false,
    // Reset ephemeral fields so each run is clean
    hop_count: 0,
    retrieved_chunks: [],
    cited_sources: [],
    retrievedDocs: [],
    complexity: null,
    reasoning: null,
    final_answer: null,
    planning_steps: null,
    action_result: null,
    action_error: null,
    awaiting_approval: false,
    pending_write_action: null,
  };

  let finalAnswer = "";
  let citedSources: EvaluationResult["cited_sources"] = [];

  const stream = await graph.stream(initialState, {
    configurable: { thread_id: threadId(watchlistId) },
    streamMode: ["values"],
  });

  for await (const [, frame] of stream) {
    if (frame?.final_answer) {
      finalAnswer = typeof frame.final_answer === "string"
        ? frame.final_answer
        : frame.final_answer?.answer ?? JSON.stringify(frame.final_answer);
    }
    if (frame?.cited_sources?.length) {
      citedSources = frame.cited_sources.map((s: any) => ({
        document_id: s.document_id,
        title: s.title ?? null,
        source_type: s.source_type,
        external_url: s.external_url ?? null,
      }));
    }
    // Fallback: last assistant message content
    if (!finalAnswer && frame?.messages?.length) {
      const last = frame.messages[frame.messages.length - 1];
      if (last?.content && last._getType?.() === "ai") {
        finalAnswer = typeof last.content === "string"
          ? last.content
          : last.content.map((c: any) => c.text ?? "").join("");
      }
    }
  }

  if (!finalAnswer) throw new Error("Watchlist evaluation produced no answer");

  return {
    answer: finalAnswer,
    cited_sources: citedSources,
    answer_hash: hashAnswer(finalAnswer),
  };
}
