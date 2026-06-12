// ============================================================
// lib/knowledge-graph/__tests__/identity-lookup.test.ts (P2-4)
//
// Tests that getMyWork / getMyObligations prefer the structured
// org_member_identities path over the email-prefix heuristic.
// ============================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- In-memory tables ----------------------------------------
const orgMemberIdentities: any[] = [];
const kgNodes: any[] = [];
const kgEdges: any[] = [];

const ctx = {
  org_id: "org-1",
  user_id: "member-uuid-1",
  user_role: "member" as const,
};

// ---- Mock withRLS ----------------------------------------
vi.mock("@/lib/supabase/rls-client", () => {
  const buildQuery = (table: string) => {
    const state: any = { _table: table, _filters: [], _selected: "*", _limit: undefined };

    const proxy: any = new Proxy(state, {
      get(_target, prop: string) {
        if (prop === "select") return (f: any) => { state._selected = f; return proxy; };
        if (prop === "eq") return (col: any, val: any) => { state._filters.push({ type: "eq", col, val }); return proxy; };
        if (prop === "in") return (col: any, vals: any[]) => { state._filters.push({ type: "in", col, vals }); return proxy; };
        if (prop === "or") return () => proxy; // ignore complex OR filters — returns all matching eq rows
        if (prop === "limit") return (n: any) => { state._limit = n; return proxy; };
        if (prop === "maybeSingle") return async () => resolveQuery(state, true);
        if (prop === "single") return async () => resolveQuery(state, false);
        if (prop === "then") return (resolve: any) => Promise.resolve(resolveQuery(state, false)).then(resolve);
        return proxy;
      },
    });
    return proxy;
  };

  function resolveQuery(state: any, single: boolean) {
    const source =
      state._table === "org_member_identities" ? orgMemberIdentities :
      state._table === "kg_nodes" ? kgNodes :
      state._table === "kg_edges" ? kgEdges : [];

    let result = source.filter((row: any) =>
      state._filters.every((f: any) => {
        if (f.type === "eq") return row[f.col] === f.val;
        if (f.type === "in") {
          // handle metadata->>'provider_account_id' style key
          if (f.col.includes("->>")) {
            const metaKey = f.col.split("->>")[1];
            return f.vals.includes(row.metadata?.[metaKey]);
          }
          return f.vals.includes(row[f.col]);
        }
        return true;
      })
    );
    if (state._limit) result = result.slice(0, state._limit);
    if (single) return { data: result[0] ?? null, error: null };
    return { data: result, error: null };
  }

  return {
    withRLS: (_ctx: any, fn: any) => fn({ from: buildQuery }),
    RLSContext: {},
  };
});

// ---- Mock resolveEntity --------------------------------------
const mockResolveEntity = vi.fn();
vi.mock("../entity-resolver", () => ({ resolveEntity: (...args: any[]) => mockResolveEntity(...args) }));

import { getMyWork } from "../my-work";
import { getMyObligations } from "../my-obligations";

describe("identity lookup — structured path (P2-4)", () => {
  beforeEach(() => {
    orgMemberIdentities.length = 0;
    kgNodes.length = 0;
    kgEdges.length = 0;
    vi.clearAllMocks();
  });

  it("getMyWork: uses org_member_identities to find person node by provider_account_id", async () => {
    orgMemberIdentities.push({
      org_id: "org-1", member_id: "member-uuid-1",
      external_id: "github-alice", external_email: null, provider: "github",
    });
    kgNodes.push({
      id: "person-node-1", org_id: "org-1", entity_type: "person",
      label: "alice", metadata: { provider_account_id: "github-alice" },
    });

    const result = await getMyWork(ctx, { displayName: "Alice", email: "alice@company.com" });

    // resolveEntity (heuristic) should NOT have been called since structured path succeeded
    expect(mockResolveEntity).not.toHaveBeenCalled();
    // person node was resolved
    expect(result.person?.id).toBe("person-node-1");
  });

  it("getMyWork: falls back to heuristic when no identity records exist", async () => {
    // No org_member_identities rows
    mockResolveEntity.mockResolvedValueOnce([{ canonicalNodeId: "person-node-fallback" }]);
    kgNodes.push({
      id: "person-node-fallback", org_id: "org-1", entity_type: "person",
      label: "Alice Smith", metadata: {},
    });

    await getMyWork(ctx, { displayName: "Alice Smith", email: "alice@company.com" });
    expect(mockResolveEntity).toHaveBeenCalledWith(ctx, "Alice Smith", expect.any(Object));
  });

  it("getMyWork: falls back to heuristic when identity exists but no kg_node matches", async () => {
    orgMemberIdentities.push({
      org_id: "org-1", member_id: "member-uuid-1",
      external_id: "unknown-ext-id", external_email: null, provider: "github",
    });
    // No kg_node with that provider_account_id
    mockResolveEntity.mockResolvedValueOnce([{ canonicalNodeId: "person-node-fallback" }]);
    kgNodes.push({
      id: "person-node-fallback", org_id: "org-1", entity_type: "person",
      label: "Alice", metadata: {},
    });

    await getMyWork(ctx, { displayName: "Alice", email: "alice@company.com" });
    expect(mockResolveEntity).toHaveBeenCalled();
  });

  it("getMyObligations: uses structured path when identities are available", async () => {
    orgMemberIdentities.push({
      org_id: "org-1", member_id: "member-uuid-1",
      external_id: "linear-alice-id", external_email: "alice@linear.app", provider: "linear",
    });
    kgNodes.push({
      id: "person-node-linear", org_id: "org-1", entity_type: "person",
      label: "alice", metadata: { provider_account_id: "linear-alice-id" },
    });

    const result = await getMyObligations(ctx, { displayName: "Alice", email: "alice@company.com" });
    expect(mockResolveEntity).not.toHaveBeenCalled();
    expect(result.person?.id).toBe("person-node-linear");
  });

  it("getMyObligations: skips structured path when user_id is 'system'", async () => {
    orgMemberIdentities.push({
      org_id: "org-1", member_id: "system",
      external_id: "some-id", external_email: null, provider: "github",
    });
    mockResolveEntity.mockResolvedValueOnce([]);
    const systemCtx = { ...ctx, user_id: "system" };
    await getMyObligations(systemCtx, { displayName: "Alice" });
    // Should have tried heuristic, not identity lookup
    expect(mockResolveEntity).toHaveBeenCalled();
  });
});
