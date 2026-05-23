// ============================================================
// lib/langgraph/nodes/__tests__/email-agent.test.ts
//
// Unit tests for the email-agent LangGraph node (8A.3).
//
// The node wraps lib/agents/email-agent.emailAgentNode(), which:
//   1. Builds a prompt from state (conversation + retrieved context)
//   2. Calls the LLM to draft an email
//   3. Returns pending_write_action + awaiting_approval=true for HITL gate
//      — OR — run_status=failed when the LLM produces an empty draft
//
// The LLM is mocked; real network calls are never made.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (hoisted before imports) ──────────────────────────────────────────

const mockLLMInvoke = vi.fn();

vi.mock("@/lib/langgraph/llm-factory", () => ({
  resolveModelClient: vi.fn(async () => ({
    invoke: (...args: unknown[]) => mockLLMInvoke(...args),
  })),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Module under test ───────────────────────────────────────────────────────

import { emailAgentNode } from "../email-agent";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-test-uuid",
    userId: "user-test-uuid",
    role: "member",
    messages: [
      { _getType: () => "human", content: "Send a meeting invite to alice@example.com" },
    ],
    retrieved_chunks: [
      { content_preview: "Alice Smith <alice@example.com> — Engineering lead" },
    ],
    awaiting_approval: false,
    pending_write_action: null,
    run_status: "running",
    ...overrides,
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("emailAgentNode — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets pending_write_action.tool = 'email-send' and awaiting_approval=true (HITL gate)", async () => {
    mockLLMInvoke.mockResolvedValue({
      content: JSON.stringify({
        to: ["alice@example.com"],
        cc: [],
        subject: "Meeting Invite",
        body: "Hi Alice, let's meet tomorrow.",
      }),
    });

    const result = await emailAgentNode(makeState());

    expect(result.awaiting_approval).toBe(true);
    expect(result.run_status).toBe("awaiting_approval");
    expect((result.pending_write_action as any)?.tool).toBe("email-send");
  });

  it("payload includes the drafted to/subject/body from the LLM", async () => {
    mockLLMInvoke.mockResolvedValue({
      content: JSON.stringify({
        to: ["bob@example.com"],
        cc: ["cc@example.com"],
        subject: "Project Update",
        body: "Hi Bob, here is the update.",
      }),
    });

    const result = await emailAgentNode(makeState());

    const payload = (result.pending_write_action as any)?.payload;
    expect(payload?.to).toEqual(["bob@example.com"]);
    expect(payload?.cc).toEqual(["cc@example.com"]);
    expect(payload?.subject).toBe("Project Update");
    expect(payload?.body).toContain("Bob");
  });

  it("includes requested_at timestamp in the pending action", async () => {
    mockLLMInvoke.mockResolvedValue({
      content: JSON.stringify({
        to: ["alice@example.com"],
        cc: [],
        subject: "Hello",
        body: "Hello.",
      }),
    });

    const result = await emailAgentNode(makeState());

    const requestedAt = (result.pending_write_action as any)?.requested_at;
    expect(requestedAt).toBeDefined();
    // new Date(undefined) does NOT throw — use getTime().not.toBeNaN() to catch missing values
    expect(new Date(requestedAt).getTime()).not.toBeNaN();
  });
});

describe("emailAgentNode — empty draft path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns run_status=failed when LLM returns empty to/subject/body", async () => {
    // LLM returns JSON with no usable content
    mockLLMInvoke.mockResolvedValue({
      content: JSON.stringify({ to: [], cc: [], subject: "", body: "" }),
    });

    const result = await emailAgentNode(makeState());

    expect(result.run_status).toBe("failed");
    expect(result.awaiting_approval).toBeUndefined();
    expect(result.pending_write_action).toBeUndefined();
  });

  it("returns run_status=failed when LLM returns malformed JSON", async () => {
    mockLLMInvoke.mockResolvedValue({ content: "not valid JSON at all" });

    const result = await emailAgentNode(makeState());

    // Malformed JSON → fallback draft with empty fields → hasContent = false → failed
    expect(result.run_status).toBe("failed");
  });
});
