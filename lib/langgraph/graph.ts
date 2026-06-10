import { StateGraph, START, END } from "@langchain/langgraph";
import { AtheneState } from "./state";
import { supervisor } from "./nodes/supervisor";
import { retrievalAgent } from "./nodes/retrieval-agent";
import { crossDeptRetrievalAgent } from "./nodes/cross-dept-retrieval";
import { synthesisAgentNode } from "./nodes/synthesis-agent";
import { plannerAgent } from "./nodes/planner-agent";
import { integrationAgentNode } from "./nodes/integration-agent";
import { diffAgentNode } from "./nodes/diff-agent";
import { watchlistAgentNode } from "./nodes/watchlist-agent";
import { actionExecutorNode } from "./nodes/action-executor";
import { getCheckpointer } from "./checkpointer";

// FROZEN (REFOCUS §3.1/§3.2): email_agent, calendar_agent, and report_agent
// are out of the graph while the product is read-only. Node files remain at
// ./nodes/{email-agent,calendar-agent,report-agent}.ts — restore behind
// WRITE_ACTIONS_ENABLED to unfreeze.
// action_executor IS wired back (§6.4) — watchlist-create is an internal
// Athene write (not an external write action) so it bypasses the freeze flag.

// Shared compilation promise to prevent race conditions during cold starts
let _compilingPromise: Promise<any> | null = null;

export async function getAgentGraph(): Promise<any> {
  if (_compilingPromise) return _compilingPromise;

  _compilingPromise = (async () => {
    try {
      const checkpointer = await getCheckpointer();

      const workflow = new StateGraph(AtheneState)
        // Router
        .addNode("supervisor", supervisor)
        // Multi-step query planner (Sprint 4C) — decomposes complex cross-dept queries
        .addNode("planner", plannerAgent)
        // Worker nodes
        .addNode("retrieval", retrievalAgent)
        .addNode("cross_dept_retrieval", crossDeptRetrievalAgent)
        // Read-only since REFOCUS §3.1: list/status only, writes point to settings UI
        .addNode("integration_agent", integrationAgentNode)
        // Temporal diff agent (REFOCUS §5.4) — "what changed since X" queries
        .addNode("diff_agent", diffAgentNode)
        .addNode("synthesis", synthesisAgentNode)
        // §6.4: "watch this" HITL — internal write, not gated by WRITE_ACTIONS_ENABLED
        .addNode("watchlist_agent", watchlistAgentNode)
        .addNode("action_executor", actionExecutorNode);

      // Edges
      workflow.addEdge(START, "supervisor");

      // Planner outputs planning_steps then hands off to retrieval
      workflow.addEdge("planner", "retrieval");

      // Workers always return to the supervisor after completion
      workflow.addEdge("retrieval", "supervisor");
      workflow.addEdge("cross_dept_retrieval", "supervisor");
      workflow.addEdge("integration_agent", "supervisor");

      // watchlist_agent pauses for HITL approval; action_executor runs on approval
      workflow.addEdge("watchlist_agent", END);
      workflow.addEdge("action_executor", END);

      // Synthesis is the terminal node for answers
      workflow.addEdge("synthesis", END);

      // Diff agent produces a complete final_answer itself — terminal
      workflow.addEdge("diff_agent", END);

      // The supervisor routes to a worker, planner, synthesis, or END.
      // action_executor is intentionally absent from ALL_AGENTS (so the LLM
      // can never route there) — only the HITL resume guard in supervisor.ts
      // sets next_node="action_executor", and it must be in this map to be
      // reachable.
      workflow.addConditionalEdges(
        "supervisor",
        (state) => state.next_node || "END",
        {
          planner: "planner",
          retrieval: "retrieval",
          cross_dept_retrieval: "cross_dept_retrieval",
          integration_agent: "integration_agent",
          diff_agent: "diff_agent",
          watchlist_agent: "watchlist_agent",
          action_executor: "action_executor",
          synthesis: "synthesis",
          END: END,
        }
      );

      return workflow.compile({ checkpointer });
    } catch (err) {
      _compilingPromise = null; // Allow retry on failure
      throw err;
    }
  })();

  return _compilingPromise;
}


