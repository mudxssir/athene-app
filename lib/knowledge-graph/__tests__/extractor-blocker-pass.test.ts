// P2-11: blocker/obligation third extraction pass.
// Verifies pass gating by source type, obligation_metadata normalization
// (flat due_date/actor/status keys consumed by my-obligations.ts), and
// additive merge through the existing node/edge dedup.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Each LLM call records its system prompt and returns the canned response
// for its call index. The three passes start in deterministic order
// (general, decision, blocker) inside Promise.all.
let mockResponses: string[] = [];
let mockCallCount = 0;
let capturedPrompts: string[] = [];

vi.mock("@/lib/langgraph/llm-factory", () => ({
  resolveModelClient: vi.fn().mockImplementation(async () => ({
    invoke: async (messages: Array<{ content: unknown }>) => {
      capturedPrompts.push(String(messages[0]?.content ?? ""));
      return {
        content: [{ type: "text", text: mockResponses[mockCallCount++] ?? "{}" }],
      };
    },
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
    rpc: vi.fn().mockResolvedValue({ data: "test-key", error: null }),
  },
}));

vi.mock("@/lib/knowledge-graph/modules/resolver", () => ({
  resolveExtractionPrompt: vi.fn().mockResolvedValue("GENERAL extraction prompt."),
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { extractEntitiesAndRelations } from "@/lib/knowledge-graph/extractor";
import type { ExtractorChunk } from "@/lib/knowledge-graph/types";

const EMPTY = JSON.stringify({ entities: [], relationships: [] });

const OBLIGATION_RESPONSE = JSON.stringify({
  entities: [
    {
      label: "Ship billing migration",
      entity_type: "obligation",
      description: "Committed in ticket comments",
      obligation_metadata: { due_date: "2026-06-19", actor: "Priya", status: "Open" },
    },
    { label: "Priya", entity_type: "person" },
    { label: "ENG-42: Fix login", entity_type: "ticket" },
  ],
  relationships: [
    {
      source: "Ship billing migration",
      source_entity_type: "obligation",
      target: "Priya",
      target_entity_type: "person",
      relation: "OBLIGATES",
      provenance: "EXTRACTED",
      confidence: 1.0,
    },
    {
      source: "ENG-42: Fix login",
      source_entity_type: "ticket",
      target: "Ship billing migration",
      target_entity_type: "obligation",
      relation: "BLOCKS",
      provenance: "INFERRED",
      confidence: 0.8,
    },
  ],
});

function chunk(provider: string, overrides: Partial<ExtractorChunk> = {}): ExtractorChunk {
  return {
    text: "Priya said she will ship the billing migration by Friday, blocked by ENG-42.",
    chunk_index: 0,
    org_id: "org-1",
    document_id: "doc-1",
    department_id: "dept-1",
    visibility: "department",
    metadata: { provider },
    ...overrides,
  } as ExtractorChunk;
}

beforeEach(() => {
  mockResponses = [];
  mockCallCount = 0;
  capturedPrompts = [];
});

describe("P2-11 blocker/obligation pass — gating by source type", () => {
  it("jira (work_item, not a decision source) → general + blocker = 2 calls", async () => {
    mockResponses = [EMPTY, EMPTY];
    await extractEntitiesAndRelations([chunk("jira")], {} as never);
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[0]).toContain("GENERAL");
    expect(capturedPrompts[1]).toContain("Blocker & Obligation");
  });

  it("slack (decision source + gated thread) → general + decision + blocker = 3 calls", async () => {
    mockResponses = [EMPTY, EMPTY, EMPTY];
    await extractEntitiesAndRelations([chunk("slack")], {} as never);
    expect(capturedPrompts).toHaveLength(3);
    expect(capturedPrompts[1]).toContain("Decision Record");
    expect(capturedPrompts[2]).toContain("Blocker & Obligation");
  });

  it("notion (prose) → general + decision only; no blocker pass", async () => {
    mockResponses = [EMPTY, EMPTY];
    await extractEntitiesAndRelations([chunk("notion")], {} as never);
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts.some((p) => p.includes("Blocker & Obligation"))).toBe(false);
  });

  it("unknown provider → general pass only", async () => {
    mockResponses = [EMPTY];
    await extractEntitiesAndRelations([chunk("randomtool")], {} as never);
    expect(capturedPrompts).toHaveLength(1);
  });

  it("indexer path: metadata.source_type (not provider) also gates the pass", async () => {
    // lib/langgraph/tools/indexer.ts threads { ...metadata, source_type } —
    // this pins the source_type key so the indexer path can never silently
    // regress to general-only extraction again.
    mockResponses = [EMPTY, EMPTY];
    await extractEntitiesAndRelations(
      [chunk("ignored", { metadata: { source_type: "linear" } } as never)],
      {} as never
    );
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toContain("Blocker & Obligation");
  });

  it("chunk without metadata → general pass only (no crash)", async () => {
    mockResponses = [EMPTY];
    await extractEntitiesAndRelations(
      [chunk("ignored", { metadata: undefined } as never)],
      {} as never
    );
    expect(capturedPrompts).toHaveLength(1);
  });
});

describe("P2-11 obligation metadata normalization", () => {
  it("due_date/actor/status land as flat metadata keys (my-obligations contract)", async () => {
    mockResponses = [EMPTY, OBLIGATION_RESPONSE]; // general empty, blocker full
    const { nodes } = await extractEntitiesAndRelations([chunk("linear")], {} as never);

    const obligation = nodes.find((n) => n.entity_type === "obligation");
    expect(obligation).toBeDefined();
    expect(obligation!.metadata).toMatchObject({
      due_date: "2026-06-19",
      actor: "Priya",
      status: "open", // lower-cased
    });
  });

  it("omits absent metadata fields without fabricating them", async () => {
    mockResponses = [
      EMPTY,
      JSON.stringify({
        entities: [
          { label: "Update runbook", entity_type: "obligation", obligation_metadata: { actor: "Sam" } },
        ],
        relationships: [],
      }),
    ];
    const { nodes } = await extractEntitiesAndRelations([chunk("github")], {} as never);
    const obligation = nodes.find((n) => n.entity_type === "obligation");
    expect(obligation!.metadata).toMatchObject({ actor: "Sam" });
    expect(obligation!.metadata).not.toHaveProperty("due_date");
  });

  it("general-pass entities never get obligation metadata (flag is per-pass)", async () => {
    mockResponses = [
      JSON.stringify({
        entities: [
          { label: "Some task", entity_type: "obligation", obligation_metadata: { due_date: "2026-07-01" } },
        ],
        relationships: [],
      }),
      EMPTY,
    ];
    const { nodes } = await extractEntitiesAndRelations([chunk("jira")], {} as never);
    const obligation = nodes.find((n) => n.entity_type === "obligation");
    expect(obligation).toBeDefined();
    expect(obligation!.metadata ?? {}).not.toHaveProperty("due_date");
  });
});

describe("P2-11 merge through existing dedup", () => {
  it("blocker edges and entities merge additively with the general pass", async () => {
    const generalResponse = JSON.stringify({
      entities: [
        { label: "ENG-42: Fix login", entity_type: "ticket" },
        { label: "Billing Service", entity_type: "service" },
      ],
      relationships: [],
    });
    mockResponses = [generalResponse, OBLIGATION_RESPONSE];
    const { nodes, edges } = await extractEntitiesAndRelations([chunk("jira")], {} as never);

    // Ticket appears in BOTH passes → deduped to one node
    const tickets = nodes.filter((n) => n.entity_type === "ticket");
    expect(tickets).toHaveLength(1);
    // Entities from both passes survive
    expect(nodes.some((n) => n.entity_type === "service")).toBe(true);
    expect(nodes.some((n) => n.entity_type === "obligation")).toBe(true);
    // Blocker edges arrive with their provenance intact
    const obligates = edges.find((e) => e.relation === "OBLIGATES");
    expect(obligates).toMatchObject({ provenance: "EXTRACTED", confidence: 1.0 });
    const blocks = edges.find((e) => e.relation === "BLOCKS");
    expect(blocks).toMatchObject({ provenance: "INFERRED", confidence: 0.8 });
  });

  it("a blocker-pass failure degrades to the other passes (no throw)", async () => {
    mockResponses = [
      JSON.stringify({
        entities: [{ label: "Project X", entity_type: "project" }],
        relationships: [],
      }),
      "this is not json at all",
      "still not json", // retry with JSON reminder also fails
    ];
    const { nodes } = await extractEntitiesAndRelations([chunk("jira")], {} as never);
    expect(nodes.some((n) => n.label === "project x")).toBe(true);
  });
});
