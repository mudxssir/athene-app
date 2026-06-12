// ============================================================
// lib/langgraph/nodes/__tests__/action-executor.test.ts
//
// Covers the write-execution path for email-send and
// calendar-create via both Google and Microsoft providers.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (must be declared before imports) ─────────────────

const mockSendMicrosoftEmail = vi.fn();
const mockCreateMicrosoftEvent = vi.fn();
const mockSendGoogleEmail = vi.fn();
const mockCreateGoogleEvent = vi.fn();
const mockSupabaseFrom = vi.fn();
const mockSupabaseRpc = vi.fn();

vi.mock("@/lib/integrations/microsoft/outlook-fetcher", () => ({
  sendEmail: (...args: unknown[]) => mockSendMicrosoftEmail(...args),
}));

vi.mock("@/lib/integrations/microsoft/calendar-fetcher", () => ({
  createEvent: (...args: unknown[]) => mockCreateMicrosoftEvent(...args),
}));

vi.mock("@/lib/integrations/google/gmail-fetcher", () => ({
  sendEmail: (...args: unknown[]) => mockSendGoogleEmail(...args),
}));

vi.mock("@/lib/integrations/google/calendar-fetcher", () => ({
  createCalendarEvent: (...args: unknown[]) => mockCreateGoogleEvent(...args),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/telemetry/metrics", () => ({
  recordHitlApprovalDuration: vi.fn(),
  incrementHitlDecision: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────────

import { actionExecutorNode } from "../action-executor";

// ─── Helpers ─────────────────────────────────────────────────

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-test",
    userId: "user-test",
    role: "member",
    messages: [],
    next_node: "",
    retrievedDocs: [],
    awaiting_approval: true,
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

function makeConnectionQuery(provider: string) {
  // Chain shape must match resolveConnection: select→eq→in→order→limit(resolves)
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({
      data: [{ connection_id: "conn-1", provider_config_key: provider }],
      error: null,
    }),
  };
}

const validEmailPayload = {
  to: ["alice@example.com"],
  cc: [],
  subject: "Hello",
  body: "Test body",
};

const validCalendarPayload = {
  summary: "Team Sync",
  description: "Weekly meeting",
  start: { dateTime: "2026-05-20T10:00:00Z", timeZone: "UTC" },
  end: { dateTime: "2026-05-20T11:00:00Z", timeZone: "UTC" },
  attendees: [{ email: "bob@example.com", displayName: "Bob" }],
};

// ─── Tests ───────────────────────────────────────────────────

describe("actionExecutorNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── No action pending ─────────────────────────────────────

  it("returns run_status:running and awaiting_approval:false when no pending action", async () => {
    const result = await actionExecutorNode(makeState({ pending_write_action: null }));

    expect(result.run_status).toBe("running");
    expect(result.awaiting_approval).toBe(false);
    expect(mockSupabaseFrom).not.toHaveBeenCalled();
  });

  // ── Email via Google ──────────────────────────────────────

  it("dispatches email-send via Google when provider is google", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("google"));
    mockSendGoogleEmail.mockResolvedValue({ id: "msg-001" });

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "email-send", payload: validEmailPayload },
      })
    );

    expect(mockSendGoogleEmail).toHaveBeenCalledWith(
      "conn-1",
      "org-test",
      expect.any(String) // base64url-encoded RFC 822 message
    );
    expect(mockSendMicrosoftEmail).not.toHaveBeenCalled();
    expect(result.action_result).toEqual({ id: "msg-001" });
    expect(result.action_error).toBeNull();
    expect(result.pending_write_action).toBeNull();
    expect(result.awaiting_approval).toBe(false);
  });

  // ── Email via Microsoft ───────────────────────────────────

  it("dispatches email-send via Microsoft when provider is microsoft", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("microsoft"));
    mockSendMicrosoftEmail.mockResolvedValue({ id: "msg-ms-001" });

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "email-send", payload: validEmailPayload },
      })
    );

    expect(mockSendMicrosoftEmail).toHaveBeenCalledWith(
      "conn-1",
      "org-test",
      expect.objectContaining({ toRecipients: expect.any(Array) })
    );
    expect(mockSendGoogleEmail).not.toHaveBeenCalled();
    expect(result.action_result).toEqual({ id: "msg-ms-001" });
    expect(result.action_error).toBeNull();
  });

  // ── Calendar via Google ───────────────────────────────────

  it("dispatches calendar-create via Google when provider is google", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("google"));
    mockCreateGoogleEvent.mockResolvedValue({ id: "cal-001" });

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "calendar-create", payload: validCalendarPayload },
      })
    );

    expect(mockCreateGoogleEvent).toHaveBeenCalledWith(
      "conn-1",
      "org-test",
      expect.objectContaining({ summary: "Team Sync" })
    );
    expect(mockCreateMicrosoftEvent).not.toHaveBeenCalled();
    expect(result.action_result).toEqual({ id: "cal-001" });
    expect(result.action_error).toBeNull();
  });

  // ── Calendar via Microsoft ────────────────────────────────

  it("dispatches calendar-create via Microsoft when provider is microsoft", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("microsoft"));
    mockCreateMicrosoftEvent.mockResolvedValue({ id: "cal-ms-001" });

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "calendar-create", payload: validCalendarPayload },
      })
    );

    expect(mockCreateMicrosoftEvent).toHaveBeenCalledWith(
      "conn-1",
      "org-test",
      expect.objectContaining({ subject: "Team Sync" })
    );
    expect(mockCreateGoogleEvent).not.toHaveBeenCalled();
    expect(result.action_result).toEqual({ id: "cal-ms-001" });
  });

  // ── Validation errors ─────────────────────────────────────

  it("records action_error when email payload has no recipients", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("google"));

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: {
          tool: "email-send",
          payload: { to: [], subject: "Hello", body: "test" },
        },
      })
    );

    expect(result.action_error).toMatch(/missing recipients/i);
    expect(result.action_result).toBeNull();
    expect(result.pending_write_action).toBeNull();
    expect(result.awaiting_approval).toBe(false);
    expect(mockSendGoogleEmail).not.toHaveBeenCalled();
  });

  it("records action_error when calendar payload is missing required fields", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("google"));

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: {
          tool: "calendar-create",
          payload: { summary: "Meeting" }, // missing start/end
        },
      })
    );

    expect(result.action_error).toMatch(/missing required event fields/i);
    expect(result.action_result).toBeNull();
    expect(mockCreateGoogleEvent).not.toHaveBeenCalled();
  });

  // ── Unknown tool ──────────────────────────────────────────

  it("records action_error for unknown tool", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("google"));

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: {
          tool: "unknown-tool",
          payload: {},
        },
      })
    );

    expect(result.action_error).toMatch(/unknown action tool/i);
    expect(result.action_result).toBeNull();
  });

  // ── No connections ────────────────────────────────────────

  it("records action_error when no active connections exist for org", async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    });

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "email-send", payload: validEmailPayload },
      })
    );

    expect(result.action_error).toMatch(/No active connections/i);
    expect(result.action_result).toBeNull();
  });

  // ── Supabase error during connection lookup ───────────────

  it("records action_error when connection lookup fails", async () => {
    mockSupabaseFrom.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: null,
        error: { message: "DB connection refused" },
      }),
    });

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "email-send", payload: validEmailPayload },
      })
    );

    expect(result.action_error).toMatch(/Failed to resolve connections/i);
  });

  // ── Integration call failure ──────────────────────────────

  it("records action_error when integration throws", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("google"));
    mockSendGoogleEmail.mockRejectedValue(new Error("Gmail API rate limit exceeded"));

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "email-send", payload: validEmailPayload },
      })
    );

    expect(result.action_error).toBe("Gmail API rate limit exceeded");
    expect(result.action_result).toBeNull();
    expect(result.awaiting_approval).toBe(false);
    expect(result.pending_write_action).toBeNull();
  });

  // ── CC field handling ─────────────────────────────────────

  it("includes CC recipients in Google email RFC 822 message", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("google"));
    mockSendGoogleEmail.mockResolvedValue({ id: "msg-cc-001" });

    await actionExecutorNode(
      makeState({
        pending_write_action: {
          tool: "email-send",
          payload: {
            to: ["alice@example.com"],
            cc: ["charlie@example.com"],
            subject: "CC Test",
            body: "With CC",
          },
        },
      })
    );

    const rawB64 = mockSendGoogleEmail.mock.calls[0][2] as string;
    const decoded = Buffer.from(rawB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("Cc: charlie@example.com");
  });

  // ── Specific Provider Keys ────────────────────────────────

  it("resolves and dispatches email-send via individual gmail connection", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("gmail"));
    mockSendGoogleEmail.mockResolvedValue({ id: "gmail-msg-01" });

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "email-send", payload: validEmailPayload },
      })
    );

    expect(mockSendGoogleEmail).toHaveBeenCalledWith(
      "conn-1",
      "org-test",
      expect.any(String)
    );
    expect(result.action_result).toEqual({ id: "gmail-msg-01" });
    expect(result.action_error).toBeNull();
  });

  it("resolves and dispatches calendar-create via individual google_calendar connection", async () => {
    mockSupabaseFrom.mockReturnValue(makeConnectionQuery("google_calendar"));
    mockCreateGoogleEvent.mockResolvedValue({ id: "gcal-evt-01" });

    const result = await actionExecutorNode(
      makeState({
        pending_write_action: { tool: "calendar-create", payload: validCalendarPayload },
      })
    );

    expect(mockCreateGoogleEvent).toHaveBeenCalledWith(
      "conn-1",
      "org-test",
      expect.objectContaining({ summary: "Team Sync" })
    );
    expect(result.action_result).toEqual({ id: "gcal-evt-01" });
    expect(result.action_error).toBeNull();
  });
});
