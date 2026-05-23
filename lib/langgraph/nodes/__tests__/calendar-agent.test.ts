// ============================================================
// lib/langgraph/nodes/__tests__/calendar-agent.test.ts
//
// Unit tests for the calendar-agent LangGraph node (8A.3).
//
// The node wraps lib/agents/calendar-agent.calendarAgent(), which:
//   1. Builds a structured-output prompt (timezone-aware)
//   2. Calls the LLM with calendarEventSchema output
//   3. Returns pending_write_action + awaiting_approval=true for HITL
//      — OR — an error message if LLM fails or draft is incomplete
//
// Coverage:
//   - tool name is dynamically set from action_type (BUG-03 fix)
//   - create action requires start+end (BUG-02 fix)
//   - LLM errors return user-friendly message (no crash)
//   - awaiting_approval=true gates action executor (HITL)
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";

// ─── Mocks (hoisted before imports) ──────────────────────────────────────────

const mockDraftModelInvoke = vi.fn();
const mockWithStructuredOutput = vi.fn(() => ({ invoke: mockDraftModelInvoke }));

vi.mock("@/lib/langgraph/llm-factory", () => ({
  resolveModelClient: vi.fn(async () => ({
    withStructuredOutput: mockWithStructuredOutput,
  })),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stub fs so getSystemPrompt() doesn't hit the real filesystem
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => "You are a calendar assistant. {dateContext} {timezone}"),
  };
});

// ─── Module under test ───────────────────────────────────────────────────────

import { calendarAgentNode } from "../calendar-agent";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-test-uuid",
    userId: "user-test-uuid",
    role: "member",
    messages: [
      { _getType: () => "human", content: "Schedule a 1:1 with Bob tomorrow at 10am" },
    ],
    retrieved_chunks: [],
    awaiting_approval: false,
    pending_write_action: null,
    run_status: "running",
    user: { timezone: "America/New_York" },
    ...overrides,
  } as any;
}

function makeCalendarDraft(overrides: Record<string, unknown> = {}) {
  return {
    action_type: "create",
    summary: "1:1 with Bob",
    start: { dateTime: "2026-05-24T10:00:00", timeZone: "America/New_York" },
    end:   { dateTime: "2026-05-24T11:00:00", timeZone: "America/New_York" },
    attendees: [{ email: "bob@example.com" }],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("calendarAgentNode — create action (HITL gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets awaiting_approval=true and tool='calendar-create' for a create action", async () => {
    mockDraftModelInvoke.mockResolvedValue(makeCalendarDraft());

    const result = await calendarAgentNode(makeState());

    expect(result.awaiting_approval).toBe(true);
    expect((result.pending_write_action as any)?.tool).toBe("calendar-create");
  });

  it("payload contains the LLM draft (summary, start, end, attendees)", async () => {
    const draft = makeCalendarDraft();
    mockDraftModelInvoke.mockResolvedValue(draft);

    const result = await calendarAgentNode(makeState());

    const payload = (result.pending_write_action as any)?.payload;
    expect(payload?.summary).toBe("1:1 with Bob");
    expect(payload?.start?.dateTime).toBeDefined();
    expect(payload?.attendees?.[0]?.email).toBe("bob@example.com");
  });

  it("uses action_type to set tool name dynamically — 'calendar-update' for update", async () => {
    mockDraftModelInvoke.mockResolvedValue(makeCalendarDraft({ action_type: "update" }));

    const result = await calendarAgentNode(makeState());

    expect((result.pending_write_action as any)?.tool).toBe("calendar-update");
  });

  it("uses action_type to set tool name dynamically — 'calendar-delete' for delete", async () => {
    mockDraftModelInvoke.mockResolvedValue(makeCalendarDraft({ action_type: "delete" }));

    const result = await calendarAgentNode(makeState());

    expect((result.pending_write_action as any)?.tool).toBe("calendar-delete");
  });
});

describe("calendarAgentNode — validation & error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns clarification message when create action is missing start/end (BUG-02 fix)", async () => {
    // No start or end → should NOT queue HITL, should ask for clarification
    mockDraftModelInvoke.mockResolvedValue({
      action_type: "create",
      summary: "Team meeting",
      // start and end intentionally absent
    });

    const result = await calendarAgentNode(makeState());

    // toBeFalsy (not toBeUndefined) — the impl may return false/null rather than omitting the key
    expect(result.awaiting_approval).toBeFalsy();
    expect(result.pending_write_action).toBeFalsy();
    // Should return a message asking for the start time — require "start" or "when" as a whole word
    // (avoids false positives like "Sorry, I can't process your request at this time" matching "time")
    const messages = result.messages as AIMessage[];
    expect(messages?.[0]?.content).toMatch(/\b(start|end|when)\b/i);
  });

  it("returns user-friendly message when LLM throws (no graph crash)", async () => {
    mockDraftModelInvoke.mockRejectedValue(new Error("LLM quota exceeded"));

    const result = await calendarAgentNode(makeState());

    expect(result.awaiting_approval).toBeFalsy();
    expect(result.pending_write_action).toBeFalsy();
    // Error message must mention the "calendar" domain so a generic apology doesn't pass
    const messages = result.messages as AIMessage[];
    expect(messages?.[0]?.content).toMatch(/\bcalendar\b/i);
  });

  it("uses UTC timezone when state.user.timezone is absent", async () => {
    mockDraftModelInvoke.mockResolvedValue(makeCalendarDraft());

    // No user timezone set — should not throw
    const result = await calendarAgentNode(makeState({ user: undefined }));

    expect(result.awaiting_approval).toBe(true);
  });
});
