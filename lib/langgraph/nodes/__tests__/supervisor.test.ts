import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.hoisted ensures mockInvoke is available inside the hoisted vi.mock factory
const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(function () {
    return {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    };
  }),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}));

import { supervisor } from "../supervisor";
import type { AtheneState } from "../../state";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AtheneState> = {}): AtheneState {
  return {
    orgId: "org-1",
    userId: "user-1",
    role: "member",
    next_node: "",
    messages: [{ role: "user", content: "test" }] as any,
    retrievedDocs: [],
    user: null,
    task_type: null,
    complexity: "simple",
    is_cross_dept_query: false,
    hop_count: 0,
    reasoning: "",
    retrieved_chunks: [],
    run_status: "idle",
    awaiting_approval: false,
    pending_write_action: null,
    final_answer: null,
    cited_sources: [],
    action_result: null,
    action_error: null,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("supervisor", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("routes a general document query to retrieval", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "retrieval",
      task_type: "document_search",
      complexity: "simple",
      reasoning: "User is looking for documents.",
    });

    const state = makeState({
      messages: [{ role: "user", content: "Find our Q3 OKR docs" }] as any,
    });
    const result = await supervisor(state);

    expect(result.next_node).toBe("retrieval");
    expect(result.task_type).toBe("document_search");
    expect(result.hop_count).toBe(1);
    expect(result.is_cross_dept_query).toBe(false);
  });

  it("routes a cross-dept BI query to cross_dept_retrieval for super_user", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "cross_dept_retrieval",
      task_type: "cross_dept_analysis",
      complexity: "complex",
      reasoning: "Revenue trends require cross-department access.",
    });

    const state = makeState({
      role: "super_user",
      messages: [{ role: "user", content: "Show revenue trends across all teams" }] as any,
    });
    const result = await supervisor(state);

    expect(result.next_node).toBe("cross_dept_retrieval");
    expect(result.is_cross_dept_query).toBe(true);
    expect(result.complexity).toBe("complex");
    expect(result.hop_count).toBe(1);
  });

  it("overrides cross_dept_retrieval to retrieval for member role (guard rail)", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "cross_dept_retrieval",
      task_type: "cross_dept_analysis",
      complexity: "complex",
      reasoning: "Attempting cross-dept access.",
    });

    const state = makeState({
      role: "member",
      messages: [{ role: "user", content: "Show revenue trends across all teams" }] as any,
    });
    const result = await supervisor(state);

    expect(result.next_node).toBe("retrieval");
    expect(result.is_cross_dept_query).toBe(false);
    expect(result.task_type).toBe("document_search");
    expect(result.reasoning).toMatch(/\[Guard\]/);
  });

  it("routes an email request to the email agent", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "email_agent",
      task_type: "email_draft",
      complexity: "medium",
      reasoning: "User wants to draft an email.",
    });

    const state = makeState({
      messages: [{ role: "user", content: "Draft an email to the engineering team" }] as any,
    });
    const result = await supervisor(state);

    expect(result.next_node).toBe("email_agent");
    expect(result.task_type).toBe("email_draft");
    expect(result.hop_count).toBe(1);
  });

  it("routes a scheduling request to the calendar agent", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "calendar_agent",
      task_type: "calendar_create",
      complexity: "medium",
      reasoning: "User wants to book a meeting.",
    });

    const state = makeState({
      messages: [{ role: "user", content: "Book a 1:1 with Sarah next Tuesday at 3pm" }] as any,
    });
    const result = await supervisor(state);

    expect(result.next_node).toBe("calendar_agent");
    expect(result.task_type).toBe("calendar_create");
    expect(result.hop_count).toBe(1);
  });

  it("routes a report request to the report agent", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "report_agent",
      task_type: "report_generation",
      complexity: "medium",
      reasoning: "User wants a formatted report from retrieved data.",
    });

    const state = makeState({
      messages: [{ role: "user", content: "Generate a report from the data you found" }] as any,
      retrieved_chunks: [{ id: "c1" } as any],
    });
    const result = await supervisor(state);

    expect(result.next_node).toBe("report_agent");
    expect(result.task_type).toBe("report_generation");
    expect(result.hop_count).toBe(1);
  });

  it("terminates immediately when max hop limit is reached without calling the LLM", async () => {
    const state = makeState({ hop_count: 6 });
    const result = await supervisor(state);

    expect(result.next_node).toBe("END");
    expect(result.reasoning).toMatch(/Max hop/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("routes to synthesis when enough context is accumulated", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "synthesis",
      task_type: "synthesis",
      complexity: "medium",
      reasoning: "Enough documents retrieved to answer the question.",
    });

    const state = makeState({
      messages: [{ role: "user", content: "Summarize what you found" }] as any,
      retrieved_chunks: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] as any,
    });
    const result = await supervisor(state);

    expect(result.next_node).toBe("synthesis");
    expect(result.hop_count).toBe(1);
  });

  it("blocks END on the first hop of a turn (multi-turn echo fix) → retrieval", async () => {
    // On a resumed thread the routing LLM sees the prior turn's answer and can
    // wrongly return END for the new question. The fresh-turn guard overrides it.
    mockInvoke.mockResolvedValue({
      next_agent: "END",
      task_type: "none",
      complexity: "simple",
      reasoning: "Looks already answered.",
    });

    const state = makeState({
      hop_count: 0,
      messages: [
        { role: "user", content: "What were Q3 OKRs?" },
        { role: "assistant", content: "Here are the Q3 OKRs…" },
        { role: "user", content: "And Q4?" },
      ] as any,
    });
    const result = await supervisor(state);

    expect(result.next_node).toBe("retrieval");
    expect(result.task_type).toBe("document_search");
    expect(result.reasoning).toMatch(/\[Guard\].*first hop/);
    expect(result.hop_count).toBe(1);
  });

  it("still allows END on a later hop (after the turn was processed)", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "END",
      task_type: "none",
      complexity: "simple",
      reasoning: "Answer already delivered this turn.",
    });

    const state = makeState({ hop_count: 2 });
    const result = await supervisor(state);

    expect(result.next_node).toBe("END"); // guard only blocks hop 0
  });

  it("increments hop_count on each invocation", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "retrieval",
      task_type: "document_search",
      complexity: "simple",
      reasoning: "searching",
    });

    const state = makeState({ hop_count: 3 });
    const result = await supervisor(state);

    expect(result.hop_count).toBe(4);
  });

  it("still calls LLM and routes correctly at hop_count 5 (near-limit)", async () => {
    mockInvoke.mockResolvedValue({
      next_agent: "synthesis",
      task_type: "synthesis",
      complexity: "simple",
      reasoning: "One hop left — routing to synthesis.",
    });

    const state = makeState({ hop_count: 5 });
    const result = await supervisor(state);

    expect(mockInvoke).toHaveBeenCalledOnce();
    expect(result.next_node).toBe("synthesis");
    expect(result.hop_count).toBe(6);
  });
});
