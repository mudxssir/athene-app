import { StateGraph, START, END } from "@langchain/langgraph";
import { AtheneState } from "./state";
import { supervisor } from "./nodes/supervisor";
import { retrievalAgent } from "./nodes/retrieval-agent";
import { crossDeptRetrievalAgent } from "./nodes/cross-dept-retrieval";
import { emailAgentNode } from "./nodes/email-agent";
import { calendarAgentNode } from "./nodes/calendar-agent";
import { synthesisAgentNode } from "./nodes/synthesis-agent";
import { actionExecutorNode } from "./nodes/action-executor";
import { reportAgent } from "./nodes/report-agent";
import { plannerAgent } from "./nodes/planner-agent";
import { integrationAgentNode } from "./nodes/integration-agent";
import { diffAgentNode } from "./nodes/diff-agent";
import { getCheckpointer } from "./checkpointer";

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
        .addNode("email_agent", emailAgentNode)
        .addNode("calendar_agent", calendarAgentNode)
        .addNode("integration_agent", integrationAgentNode)
        // Temporal diff agent (REFOCUS §5.4) — "what changed since X" queries
        .addNode("diff_agent", diffAgentNode)
        .addNode("synthesis", synthesisAgentNode)
        .addNode("report_agent", reportAgent)
        // Write-action executor (paused by interrupt_before for HITL approval)
        .addNode("action_executor", actionExecutorNode);

      // Edges
      workflow.addEdge(START, "supervisor");

      // Planner outputs planning_steps then hands off to retrieval
      workflow.addEdge("planner", "retrieval");

      // Workers always return to the supervisor after completion
      workflow.addEdge("retrieval", "supervisor");
      workflow.addEdge("cross_dept_retrieval", "supervisor");
      workflow.addEdge("email_agent", "supervisor");
      workflow.addEdge("calendar_agent", "supervisor");
      workflow.addEdge("integration_agent", "supervisor");
      workflow.addEdge("report_agent", "supervisor");
      workflow.addEdge("action_executor", "supervisor");

      // Synthesis is the terminal node for answers
      workflow.addEdge("synthesis", END);

      // Diff agent produces a complete final_answer itself — terminal
      workflow.addEdge("diff_agent", END);

      // The supervisor routes to a worker, planner, synthesis, or END
      workflow.addConditionalEdges(
        "supervisor",
        (state) => state.next_node || "END",
        {
          planner: "planner",
          retrieval: "retrieval",
          cross_dept_retrieval: "cross_dept_retrieval",
          email_agent: "email_agent",
          calendar_agent: "calendar_agent",
          integration_agent: "integration_agent",
          diff_agent: "diff_agent",
          report_agent: "report_agent",
          synthesis: "synthesis",
          action_executor: "action_executor",
          END: END,
        }
      );

      // ATH-43: The interrupt_before: ["action_executor"] halts execution
      // whenever the graph is about to run the action_executor node.
      // This gives the user a chance to review the pending_write_action
      // (set by email_agent or calendar_agent) before it actually executes.
      return workflow.compile({
        checkpointer,
        interruptBefore: ["action_executor"],
      });
    } catch (err) {
      _compilingPromise = null; // Allow retry on failure
      throw err;
    }
  })();

  return _compilingPromise;
}


