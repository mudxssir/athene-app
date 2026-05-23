// ============================================================
// lib/auth/__tests__/rbac.test.ts
//
// Unit tests for resolveUserAccess() and assertAdminRole() (8A.1).
//
// These two functions sit at the root of every request's auth chain:
//   • resolveUserAccess — resolves role + dept from Redis cache or DB
//   • assertAdminRole   — inline guard used by admin-only API routes
//
// Both query supabaseAdmin directly (service-role, no RLS).  A bug
// here bypasses all downstream row-level security.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mock state ──────────────────────────────────────────────────────

const { redisMock, supabaseMock } = vi.hoisted(() => {
  const redisMock = {
    get: vi.fn<[string], Promise<string | null>>(),
    set: vi.fn<[string, string, object?], Promise<void>>(),
    del: vi.fn<[string], Promise<void>>(),
  };

  // Minimal Supabase chainable builder.
  // Controls what maybeSingle() resolves to per-table via `tableData`.
  const tableData: Record<string, unknown> = {};

  function makeBuilder(table: string): any {
    const b: any = {};
    b.select  = () => b;
    b.eq      = () => b;
    b.limit   = () => b;
    b.insert  = (_row: unknown) => b;
    b.maybeSingle = () =>
      Promise.resolve({ data: tableData[table] ?? null, error: null });
    b.single  = () =>
      Promise.resolve({ data: tableData[table] ?? null, error: null });
    return b;
  }

  const supabaseMock = {
    tableData,
    from: vi.fn((table: string) => makeBuilder(table)),
    rpc: vi.fn(),
  };

  return { redisMock, supabaseMock };
});

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("@/lib/redis/client", () => ({
  redis: redisMock,
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: supabaseMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// React `cache()` is a server-only primitive that returns the same
// wrapped function — in unit tests we just want the raw function behaviour.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, cache: (fn: unknown) => fn };
});

// ─── Modules under test ──────────────────────────────────────────────────────

import { resolveUserAccess, assertAdminRole } from "@/lib/auth/rbac";

// ─── Constants ───────────────────────────────────────────────────────────────

const CLERK_USER_ID = "user_clerk_abc123";
const CLERK_ORG_ID  = "org_clerk_xyz789";
const INT_USER_ID   = "a1b2c3d4-0000-0000-0000-000000000001";
const INT_ORG_ID    = "b2c3d4e5-0000-0000-0000-000000000002";
const DEPT_ID       = "c3d4e5f6-0000-0000-0000-000000000003";

// ─── resolveUserAccess ────────────────────────────────────────────────────────

describe("resolveUserAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset table data between tests
    Object.keys(supabaseMock.tableData).forEach(
      (k) => delete supabaseMock.tableData[k]
    );
    redisMock.get.mockResolvedValue(null);   // cache miss by default
    redisMock.set.mockResolvedValue(undefined as any);
  });

  it("returns cached value immediately when Redis has a hit (no Supabase call)", async () => {
    const cached = {
      internal_user_id: INT_USER_ID,
      internal_org_id:  INT_ORG_ID,
      role: "admin",
      dept_id: null,
      accessible_dept_ids: null,
      bi_grant_id: null,
    };
    redisMock.get.mockResolvedValue(JSON.stringify(cached));

    // Use distinct IDs so React cache() doesn't return a previous result
    const result = await resolveUserAccess("uid-cache-hit", "oid-cache-hit");

    expect(result.role).toBe("admin");
    expect(result.internal_user_id).toBe(INT_USER_ID);
    // Supabase should NOT have been called
    expect(supabaseMock.from).not.toHaveBeenCalled();
  });

  it("resolves role from DB when Redis cache is empty", async () => {
    // Org lookup
    supabaseMock.tableData["organizations"] = { id: INT_ORG_ID };
    // Member lookup — separate eq chain.  We override `from` to return the
    // right data per query sequence.
    let orgQueried = false;
    supabaseMock.from.mockImplementation((table: string) => {
      const b: any = {};
      b.select = () => b;
      b.limit  = () => b;
      b.eq     = () => b;
      b.insert = () => b;
      b.maybeSingle = () => {
        if (table === "organizations") {
          orgQueried = true;
          return Promise.resolve({ data: { id: INT_ORG_ID }, error: null });
        }
        if (table === "org_members") {
          return Promise.resolve({
            data: { id: INT_USER_ID, role: "member", department_id: DEPT_ID },
            error: null,
          });
        }
        if (table === "access_grants") {
          return Promise.resolve({ data: [], error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      // access_grants uses array response, not maybeSingle
      b.then = (resolve: (v: any) => void) =>
        resolve({ data: [], error: null });
      return b;
    });

    // Use unique IDs to bypass React cache()
    const result = await resolveUserAccess("uid-db-hit", "oid-db-hit", "org:member");

    expect(orgQueried).toBe(true);
    expect(result.role).toBe("member");
    expect(result.dept_id).toBe(DEPT_ID);
    expect(result.internal_user_id).toBe(INT_USER_ID);
  });

  it("returns null access when both cache and DB are empty and userId/orgId missing", async () => {
    // Simulate DB returning nothing for org lookup → provisioning skipped (no userId)
    supabaseMock.from.mockImplementation(() => {
      const b: any = {
        select: () => b,
        eq: () => b,
        limit: () => b,
        insert: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (v: any) => void) => resolve({ data: null, error: null }),
      };
      return b;
    });

    const result = await resolveUserAccess("", "");

    expect(result.internal_user_id).toBeNull();
    expect(result.role).toBeNull();
  });
});

// ─── assertAdminRole ─────────────────────────────────────────────────────────

describe("assertAdminRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function stubMember(role: string | null) {
    supabaseMock.from.mockImplementation(() => {
      const b: any = {};
      b.select      = () => b;
      b.eq          = () => b;
      b.limit       = () => b;
      b.maybeSingle = () =>
        Promise.resolve({ data: role ? { role } : null, error: null });
      return b;
    });
  }

  it("returns 'admin' when the member has role=admin (8A.1)", async () => {
    stubMember("admin");
    const result = await assertAdminRole(INT_USER_ID, INT_ORG_ID);
    expect(result).toBe("admin");
  });

  it("returns 'super_user' when the member has role=super_user", async () => {
    stubMember("super_user");
    const result = await assertAdminRole(INT_USER_ID, INT_ORG_ID);
    expect(result).toBe("super_user");
  });

  it("returns null for a regular member — no admin escalation", async () => {
    stubMember("member");
    const result = await assertAdminRole(INT_USER_ID, INT_ORG_ID);
    expect(result).toBeNull();
  });

  it("returns null when the member row does not exist", async () => {
    stubMember(null);
    const result = await assertAdminRole("nonexistent-id", INT_ORG_ID);
    expect(result).toBeNull();
  });

  it("queries by primary key 'id' (not clerk_user_id) to prevent identity mismatch", async () => {
    const queriedCols: string[] = [];
    supabaseMock.from.mockImplementation(() => {
      const b: any = {};
      b.select      = () => b;
      b.eq          = (col: string) => { queriedCols.push(col); return b; };
      b.limit       = () => b;
      b.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return b;
    });

    await assertAdminRole(INT_USER_ID, INT_ORG_ID);

    // The first .eq() call must be on the primary key "id", not "clerk_user_id"
    expect(queriedCols[0]).toBe("id");
  });
});
