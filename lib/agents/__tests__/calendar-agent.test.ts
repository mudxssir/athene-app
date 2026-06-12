import { describe, it, expect, vi, beforeEach } from "vitest";
import { calendarAgent } from "../calendar-agent";
import { HumanMessage } from "@langchain/core/messages";

// 1. Use vi.hoisted to ensure these exist before the mock is called
const mocks = vi.hoisted(() => {
  const mockInvoke = vi.fn();
  const mockWithStructuredOutput = vi.fn(() => ({
    invoke: mockInvoke
  }));
  return {
    mockInvoke,
    mockWithStructuredOutput
  };
});

// 2. Mock the LLM factory using the hoisted variables
vi.mock("../../langgraph/llm-factory", () => {
  const mockModel = {
    withStructuredOutput: mocks.mockWithStructuredOutput
  };
  return {
    model: mockModel,
    getModel: vi.fn(() => mockModel),
    resolveModelClient: vi.fn().mockResolvedValue(mockModel),
  };
});

describe("calendarAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts meeting details from natural language using user timezone", async () => {
    const mockDraft = {
      action_type: "create",
      summary: "Meeting with Alice",
      start: {
        dateTime: "2024-04-24T14:00:00Z",
        timeZone: "America/New_York"
      },
      end: {
        dateTime: "2024-04-24T15:00:00Z",
        timeZone: "America/New_York"
      },
      attendees: [{ displayName: "Alice", email: "alice@example.com" }]
    };

    mocks.mockInvoke.mockResolvedValue(mockDraft);

    const state: any = {
      messages: [new HumanMessage("meeting with Alice tomorrow 2pm for 1h")],
      user: {
        timezone: "America/New_York",
        id: "user_123"
      }
    };

    const result = await calendarAgent(state);

    expect(result.awaiting_approval).toBe(true);
    expect((result.pending_write_action as any)?.tool).toBe("calendar-create");
    expect((result.pending_write_action as any)?.payload?.summary).toBe("Meeting with Alice");
  });

  it("handles search requests read-only — direct message, no HITL approval", async () => {
    // Search is read-only: the agent answers directly instead of queuing a
    // calendar-search write action through the approval flow.
    const mockDraft = {
      action_type: "search",
      is_search: true,
      summary: "Find time with Bob",
      search_range: {
        startAfter: "2024-04-25T09:00:00Z",
        endBefore: "2024-04-25T17:00:00Z"
      }
    };

    mocks.mockInvoke.mockResolvedValue(mockDraft);

    const state: any = {
      messages: [new HumanMessage("find 30 mins with Bob tomorrow")],
      user: { timezone: "UTC", id: "user_123" }
    };

    const result = await calendarAgent(state);

    expect(result.pending_write_action).toBeUndefined();
    expect(result.awaiting_approval).toBeUndefined();
    expect(result.messages?.[0].content).toContain("search your calendar");
    expect(result.messages?.[0].content).toContain("Find time with Bob");
  });

  it("validates create actions and returns a message if start/end are missing", async () => {
    const mockDraft = {
      action_type: "create",
      summary: "Incomplete meeting"
      // start/end missing
    };

    mocks.mockInvoke.mockResolvedValue(mockDraft);

    const state: any = {
      messages: [new HumanMessage("schedule a meeting sometime")],
      user: { timezone: "UTC", id: "user_123" }
    };

    const result = await calendarAgent(state);

    expect(result.awaiting_approval).toBeUndefined();
    expect(result.messages?.[0].content).toContain("missing the specific start or end time");
  });

  it("handles reschedule (update) requests", async () => {
    const mockDraft = {
      action_type: "update",
      summary: "Rescheduled Meeting",
      start: { dateTime: "2024-04-26T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2024-04-26T11:00:00Z", timeZone: "UTC" }
    };

    mocks.mockInvoke.mockResolvedValue(mockDraft);

    const state: any = {
      messages: [new HumanMessage("reschedule my 9am to 10am")],
      user: { timezone: "UTC", id: "user_123" }
    };

    const result = await calendarAgent(state);

    expect((result.pending_write_action as any)?.tool).toBe("calendar-update");
  });

  it("handles errors by returning a user-friendly message", async () => {
    mocks.mockInvoke.mockRejectedValue(new Error("LLM Error"));

    const state: any = {
      messages: [new HumanMessage("invalid request")],
      user: { timezone: "UTC", id: "user_123" }
    };

    const result = await calendarAgent(state);

    expect(result.messages?.[0].content).toContain("I'm sorry, I couldn't quite process that calendar request");
  });
});
