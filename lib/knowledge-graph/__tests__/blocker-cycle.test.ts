// ============================================================
// lib/knowledge-graph/__tests__/blocker-cycle.test.ts (P2 edge protocol)
//
// Playbook P2 edge protocol: "blocker cycles fixture (A↔B) — BFS depth
// caps verified." The P2-11 blocker pass emits BLOCKS/BLOCKED_BY edges
// straight from LLM output, so cyclic graphs WILL occur in production
// (two tickets each claiming to block the other). getMyWork's traversal
// must terminate and produce a finite, sane result on:
//   - A↔B mutual blocking (cycle through my own item)
//   - B↔C cycle one hop out (cycle among blockers)
//   - A→A self-loop (degenerate LLM output)
// Depth cap is structural (exactly 2 hops), so the test pins both the
// termination AND the cap: hop-3 nodes never appear.
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

// ---- Mock withRLS (same proxy pattern as identity-lookup.test.ts) ----
vi.mock("@/lib/supabase/rls-client", () => {
  const buildQuery = (table: string) => {
    const state: any = { _table: table, _filters: [], _limit: undefined };

    const proxy: any = new Proxy(state, {
      get(_target, prop: string) {
        if (prop === "select") return () => proxy;
        if (prop === "eq") return (col: any, val: any) => { state._filters.push({ type: "eq", col, val }); return proxy; };
        if (prop === "in") return (col: any, vals: any[]) => { state._filters.push({ type: "in", col, vals }); return proxy; };
        // OR filters (node-id fan-out) are ignored: the mock over-fetches and
        // relies on normalizeBlockerEdge's subjectId filtering — conservative
        // for cycle tests since MORE edges are visible than production would see.
        if (prop === "or") return () => proxy;
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

const mockResolveEntity = vi.fn();
vi.mock("../entity-resolver", () => ({ resolveEntity: (...args: any[]) => mockResolveEntity(...args) }));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { getMyWork } from "../my-work";

// ---- Fixture builders -----------------------------------------

function person(id: string, label: string, accountId: string) {
  return { id, org_id: "org-1", entity_type: "person", label, metadata: { provider_account_id: accountId } };
}

function ticket(id: string, label: string, status = "open") {
  return { id, org_id: "org-1", entity_type: "ticket", label, metadata: { status }, source_documents: [] };
}

let edgeSeq = 0;
/** kg_edges row with the joined source/target node objects my-work selects. */
function edge(relation: string, sourceNode: any, targetNode: any) {
  return {
    id: `edge-${++edgeSeq}`,
    org_id: "org-1",
    relation,
    source_node: sourceNode.id,
    target_node: targetNode.id,
    source: sourceNode,
    target: targetNode,
    provenance: "EXTRACTED",
    confidence: 1.0,
    source_document: null,
    created_at: "2026-06-01T00:00:00Z",
  };
}

const ALICE = person("p-alice", "alice", "alice-gh");
const IDENTITY = { displayName: "Alice", email: "alice@acme.com" };

function seedAlice() {
  orgMemberIdentities.push({
    org_id: "org-1", member_id: "member-uuid-1",
    external_id: "alice-gh", external_email: null, provider: "github",
  });
  kgNodes.push(ALICE);
}

beforeEach(() => {
  orgMemberIdentities.length = 0;
  kgNodes.length = 0;
  kgEdges.length = 0;
  edgeSeq = 0;
  vi.clearAllMocks();
  seedAlice();
});

describe("blocker cycles — BFS depth caps (P2 edge protocol)", () => {
  it("A↔B mutual blocking terminates; B appears once as A's blocker, A never appears as upstream", async () => {
    const A = ticket("t-a", "ENG-1: My ticket");
    const B = ticket("t-b", "OPS-2: Their ticket");
    kgNodes.push(A, B);
    kgEdges.push(
      edge("OWNS", ALICE, A),       // A is my item
      edge("BLOCKS", B, A),         // B blocks A
      edge("BLOCKS", A, B),         // A blocks B — the cycle edge
    );

    const result = await getMyWork(ctx, IDENTITY);

    expect(result.items).toHaveLength(1);
    const itemA = result.items[0];
    expect(itemA.node.id).toBe("t-a");
    // B blocks A exactly once
    expect(itemA.blockers).toHaveLength(1);
    expect(itemA.blockers[0].node.id).toBe("t-b");
    // The cycle edge (A blocks B) must NOT re-enter as B's upstream:
    // hop2 excludes anything in itemIdSet.
    expect(itemA.blockers[0].upstream).toHaveLength(0);
  });

  it("B↔C cycle one hop out terminates; C appears as B's upstream exactly once", async () => {
    const A = ticket("t-a", "ENG-1: My ticket");
    const B = ticket("t-b", "OPS-2: Blocker");
    const C = ticket("t-c", "SEC-3: Upstream blocker");
    kgNodes.push(A, B, C);
    kgEdges.push(
      edge("OWNS", ALICE, A),
      edge("BLOCKS", B, A),         // B blocks A
      edge("BLOCKS", C, B),         // C blocks B
      edge("BLOCKS", B, C),         // B blocks C — B↔C cycle
    );

    const result = await getMyWork(ctx, IDENTITY);

    const itemA = result.items[0];
    expect(itemA.blockers).toHaveLength(1);
    const blockerB = itemA.blockers[0];
    expect(blockerB.node.id).toBe("t-b");
    // C surfaces as B's upstream once; the B→C cycle edge does not duplicate
    // it or recurse (self-guard: blocker.id !== subjectId per hop).
    const upstreamIds = blockerB.upstream.map((u) => u.node.id);
    expect(upstreamIds).toEqual(["t-c"]);
  });

  it("depth cap: hop-3 blockers are never traversed (D blocks C stays invisible)", async () => {
    const A = ticket("t-a", "ENG-1: My ticket");
    const B = ticket("t-b", "OPS-2: Blocker");
    const C = ticket("t-c", "SEC-3: Upstream");
    const D = ticket("t-d", "LEGAL-4: Hop-3 — must not appear");
    kgNodes.push(A, B, C, D);
    kgEdges.push(
      edge("OWNS", ALICE, A),
      edge("BLOCKS", B, A),
      edge("BLOCKS", C, B),
      edge("BLOCKS", D, C),         // hop 3 — beyond the cap
    );

    const result = await getMyWork(ctx, IDENTITY);

    const collectIds = (cards: any[]): string[] =>
      cards.flatMap((c) => [c.node.id, ...collectIds(c.upstream)]);
    const seen = collectIds(result.items[0].blockers);
    expect(seen).toContain("t-b");
    expect(seen).toContain("t-c");
    expect(seen).not.toContain("t-d");
  });

  it("A→A self-loop (degenerate LLM output) is dropped by the self-guard", async () => {
    const A = ticket("t-a", "ENG-1: My ticket");
    kgNodes.push(A);
    kgEdges.push(
      edge("OWNS", ALICE, A),
      edge("BLOCKS", A, A),         // self-loop
    );

    const result = await getMyWork(ctx, IDENTITY);
    expect(result.items[0].blockers).toHaveLength(0);
  });

  it("dense cycle mesh (A↔B, B↔C, A↔C) still returns each blocker once", async () => {
    const A = ticket("t-a", "ENG-1: My ticket");
    const B = ticket("t-b", "OPS-2");
    const C = ticket("t-c", "SEC-3");
    kgNodes.push(A, B, C);
    kgEdges.push(
      edge("OWNS", ALICE, A),
      edge("BLOCKS", B, A), edge("BLOCKS", A, B),
      edge("BLOCKS", C, B), edge("BLOCKS", B, C),
      edge("BLOCKS", C, A), edge("BLOCKS", A, C),
    );

    const result = await getMyWork(ctx, IDENTITY);
    const itemA = result.items[0];
    // B and C both block A directly — each exactly once
    const hop1Ids = itemA.blockers.map((b) => b.node.id).sort();
    expect(hop1Ids).toEqual(["t-b", "t-c"]);
    // No upstream card may point back at A (itemIdSet guard)
    for (const b of itemA.blockers) {
      expect(b.upstream.map((u) => u.node.id)).not.toContain("t-a");
    }
  });
});
