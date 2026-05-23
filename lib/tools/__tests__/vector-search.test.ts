// ============================================================
// lib/tools/__tests__/vector-search.test.ts
//
// Unit tests for vectorSearch() and crossDeptVectorSearch().
//
// Coverage:
//   - 4A.5 RLS context constructed from type-safe state fields
//   - 4B.6 crossDeptVectorSearch: auth check fires BEFORE embed()
//           or any DB call (unauthorised role → no API cost)
//   - Role guard: member blocked; super_user + admin allowed
//   - Error message is actionable (not a leak)
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Controllable mocks (must be hoisted) ───────────────────────────────────

const { embedMock, mockRpc, withVectorSearchSpanMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
  mockRpc: vi.fn(),
  withVectorSearchSpanMock: vi.fn((_q: string, _o: string, _k: number, fn: (s: any) => any) =>
    fn({ setAttribute: vi.fn() })
  ),
}));

vi.mock("../../../lib/ai/embedder", () => ({ embed: embedMock }));
vi.mock("../../ai/embedder",         () => ({ embed: embedMock }));

vi.mock("../../supabase/rls-client", () => ({
  withRLS: vi.fn((_ctx: any, fn: (s: any) => any) => fn({ rpc: mockRpc })),
}));

vi.mock("../../supabase/server", () => ({
  supabaseAdmin: { rpc: mockRpc },
}));

vi.mock("../../telemetry/spans", () => ({
  withVectorSearchSpan: withVectorSearchSpanMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// ─── Module under test (imported after mocks) ────────────────────────────────

import { vectorSearch, crossDeptVectorSearch } from "../vector-search";

// ─── Helpers ────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  orgId:  "org-uuid-1234",
  userId: "user-uuid-5678",
  query:  "what is our Q3 revenue",
  topK:   5,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("vectorSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedMock.mockResolvedValue(Array(768).fill(0.1));
  });

  it("calls vector_search RPC with the embedded query (4A.5)", async () => {
    const mockData = [{ chunk_id: "c-1", content_preview: "hello" }];
    mockRpc.mockResolvedValue({ data: mockData, error: null });

    const results = await vectorSearch({ ...BASE_PARAMS, user_role: "member" });

    expect(embedMock).toHaveBeenCalledWith(BASE_PARAMS.query, BASE_PARAMS.orgId);
    expect(mockRpc).toHaveBeenCalledWith("vector_search", expect.objectContaining({ p_limit: 5 }));
    expect(results).toEqual(mockData);
  });

  it("propagates RLS context to withRLS (org_id, user_id, role, dept_id)", async () => {
    const { withRLS } = await import("../../supabase/rls-client");
    mockRpc.mockResolvedValue({ data: [], error: null });
    embedMock.mockResolvedValue(Array(768).fill(0));

    await vectorSearch({ ...BASE_PARAMS, user_role: "admin", departmentId: "dept-abc" });

    expect(withRLS).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id:        BASE_PARAMS.orgId,
        user_id:       BASE_PARAMS.userId,
        user_role:     "admin",
        department_id: "dept-abc",
      }),
      expect.any(Function),
    );
  });
});

describe("crossDeptVectorSearch — role guard fires BEFORE embed() (4B.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedMock.mockResolvedValue(Array(768).fill(0.1));
  });

  // ── Role: member blocked ──────────────────────────────────────────────────

  it("throws for role=member before calling embed() or the DB", async () => {
    await expect(
      crossDeptVectorSearch({ ...BASE_PARAMS, user_role: "member" }),
    ).rejects.toThrow(/Unauthorized/);

    // Auth check must fire BEFORE any embedding API call
    expect(embedMock).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("error message for member does not leak internal state", async () => {
    const err = await crossDeptVectorSearch({ ...BASE_PARAMS, user_role: "member" }).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/org_id|user_id|SELECT|token/i);
  });

  // ── Role: super_user allowed ──────────────────────────────────────────────

  it("allows super_user — calls vector_search_cross_dept RPC", async () => {
    const mockData = [{ chunk_id: "bi-1" }];
    mockRpc.mockResolvedValue({ data: mockData, error: null });

    const result = await crossDeptVectorSearch({ ...BASE_PARAMS, user_role: "super_user" });

    expect(embedMock).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith("vector_search_cross_dept", expect.any(Object));
    expect(result).toEqual(mockData);
  });

  // ── Role: admin allowed (4A.4 — "super_user and admin roles only") ────────

  it("allows admin — calls vector_search_cross_dept RPC (4A.4)", async () => {
    const mockData = [{ chunk_id: "bi-admin-1" }];
    mockRpc.mockResolvedValue({ data: mockData, error: null });

    const result = await crossDeptVectorSearch({ ...BASE_PARAMS, user_role: "admin" });

    expect(embedMock).toHaveBeenCalledOnce();
    expect(mockRpc).toHaveBeenCalledWith("vector_search_cross_dept", expect.any(Object));
    expect(result).toEqual(mockData);
  });

  // ── RPC error propagated ──────────────────────────────────────────────────

  it("propagates RPC errors as thrown exceptions", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: "RLS violation" } });

    await expect(
      crossDeptVectorSearch({ ...BASE_PARAMS, user_role: "super_user" }),
    ).rejects.toThrow("RLS violation");
  });
});
