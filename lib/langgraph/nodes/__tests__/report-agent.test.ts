// ============================================================
// lib/langgraph/nodes/__tests__/report-agent.test.ts
//
// Covers: section planning, vector+graph retrieval per section,
// JSON parse fallback, graph relationship extraction,
// and parseGraphRelationships helper.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ─────────────────────────────────────────────────

const mockPlannerInvoke = vi.fn();
const mockSynthesisInvoke = vi.fn();
let resolveCallCount = 0;

vi.mock("../../llm-factory", () => ({
  resolveModelClient: vi.fn().mockImplementation(() => {
    resolveCallCount++;
    const invoke = resolveCallCount === 1 ? mockPlannerInvoke : mockSynthesisInvoke;
    return Promise.resolve({ invoke });
  }),
}));

const mockVectorSearch = vi.fn();
vi.mock("@/lib/tools/vector-search", () => ({
  vectorSearch: (...args: unknown[]) => mockVectorSearch(...args),
}));

vi.mock("../../tools/graph-query", () => ({
  graphQueryTool: {
    func: vi.fn().mockResolvedValue("No knowledge graph data available"),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// ─── Import after mocks ─────────────────────────────────────

import { reportAgent, parseGraphRelationships } from "../report-agent";

// ─── Helpers ───────────────────────────────────────────────

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-1",
    userId: "user-1",
    role: "member",
    messages: [{ _getType: () => "human", content: "Generate a revenue report" }],
    next_node: "",
    awaiting_approval: false,
    pending_write_action: null,
    run_status: "running",
    final_answer: null,
    cited_sources: [],
    retrieved_chunks: [],
    action_result: null,
    action_error: null,
    task_type: null,
    is_cross_dept_query: false,
    ...overrides,
  } as any;
}

const defaultSections = ["Executive Summary", "Key Metrics", "Conclusion"];

// ─── Tests ─────────────────────────────────────────────────

describe("reportAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCallCount = 0;
    mockVectorSearch.mockResolvedValue([
      {
        document_id: "doc-1",
        chunk_id: "chunk-1",
        content_preview: "Revenue grew 20%.",
      },
    ]);
    mockSynthesisInvoke.mockResolvedValue({
      content: "This section discusses revenue trends [source: chunk-1].",
    });
  });

  it("uses planner LLM to determine report sections", async () => {
    mockPlannerInvoke.mockResolvedValue({
      content: JSON.stringify(defaultSections),
    });

    await reportAgent(makeState(), {});

    expect(mockPlannerInvoke).toHaveBeenCalledOnce();
  });

  it("falls back to default sections when planner returns invalid JSON", async () => {
    mockPlannerInvoke.mockResolvedValue({ content: "I cannot plan this." });

    const result = await reportAgent(makeState(), {});

    expect(result.final_answer).toContain("## Introduction");
    expect(result.final_answer).toContain("## Key Findings");
    expect(result.final_answer).toContain("## Conclusion");
  });

  it("returns a final_answer combining all section headings", async () => {
    mockPlannerInvoke.mockResolvedValue({
      content: JSON.stringify(["Revenue Overview", "Risk Factors"]),
    });

    const result = await reportAgent(makeState(), {});

    expect(result.final_answer).toContain("## Revenue Overview");
    expect(result.final_answer).toContain("## Risk Factors");
  });

  it("strips markdown code fences from planner JSON response", async () => {
    mockPlannerInvoke.mockResolvedValue({
      content: "```json\n" + JSON.stringify(["Intro", "Body"]) + "\n```",
    });

    const result = await reportAgent(makeState(), {});

    expect(result.final_answer).toContain("## Intro");
    expect(result.final_answer).toContain("## Body");
  });

  it("caps sections at 6 even if planner returns more", async () => {
    const manySections = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];
    mockPlannerInvoke.mockResolvedValue({
      content: JSON.stringify(manySections),
    });

    const result = await reportAgent(makeState(), {});

    // Count ## headings
    const headings = (result.final_answer as string).match(/^## /gm) ?? [];
    expect(headings.length).toBeLessThanOrEqual(6);
  });

  it("calls vectorSearch once per section", async () => {
    mockPlannerInvoke.mockResolvedValue({
      content: JSON.stringify(["Section A", "Section B", "Section C"]),
    });

    await reportAgent(makeState(), {});

    expect(mockVectorSearch).toHaveBeenCalledTimes(3);
  });

  it("uses query+section as vector search query for each section", async () => {
    mockPlannerInvoke.mockResolvedValue({
      content: JSON.stringify(["Risk Analysis"]),
    });

    await reportAgent(makeState(), {});

    const vectorArg = mockVectorSearch.mock.calls[0][0];
    expect(vectorArg.query).toContain("Generate a revenue report");
    expect(vectorArg.query).toContain("Risk Analysis");
  });
});

// ─── parseGraphRelationships ──────────────────────────────────

describe("parseGraphRelationships", () => {
  it("returns empty array for null/undefined input", () => {
    expect(parseGraphRelationships("")).toEqual([]);
    expect(parseGraphRelationships("No knowledge graph data")).toEqual([]);
  });

  it("parses standard relationship lines", () => {
    const input = "  Payment Service → DEPENDS_ON → AWS EKS [extracted, 0.95]";
    const result = parseGraphRelationships(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      source: "Payment Service",
      relation: "DEPENDS_ON",
      target: "AWS EKS",
    });
  });

  it("parses multiple relationships", () => {
    const input = [
      "  Payment Service → DEPENDS_ON → AWS EKS [extracted, 0.95]",
      "  HR Portal → RELATES_TO → Employee DB",
    ].join("\n");
    const result = parseGraphRelationships(input);
    expect(result).toHaveLength(2);
  });

  it("handles relationship with no provenance bracket", () => {
    const input = "Auth Service → CALLS → Payments API";
    const result = parseGraphRelationships(input);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe("Payments API");
  });

  it("handles hyphenated entity names", () => {
    const input = "data-pipeline → FEEDS_INTO → analytics-warehouse";
    const result = parseGraphRelationships(input);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("data-pipeline");
  });
});
