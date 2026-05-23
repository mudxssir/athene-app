import { describe, it, expect, vi } from "vitest";
import { vectorSearch, crossDeptVectorSearch } from "../vector-search";

vi.mock("../../ai/embedder", () => ({
  embed: vi.fn(async () => Array(1536).fill(0.1)),
}));

vi.mock("../../supabase/rls-client", () => ({
  withRLS: vi.fn(async (_context: any, callback: any) => {
    const mockSupabase = {
      rpc: vi.fn(async (fn: string) => {
        if (fn === "vector_search") {
          return {
            data: [{ chunk_id: "chk_std_1", document_id: "doc_std_1", metadata: { category: "general" }, score: 0.9 }],
            error: null,
          };
        }
        if (fn === "vector_search_cross_dept") {
          return {
            data: [{ chunk_id: "chk_bi_1", document_id: "doc_bi_1", metadata: { category: "revenue" }, score: 0.99 }],
            error: null,
          };
        }
        return { data: [], error: null };
      }),
    };
    return callback(mockSupabase);
  }),
}));

describe("Vector Search Access Control", () => {
  it("returns full structure for standard searches", async () => {
    const results = await vectorSearch({
      orgId: "org1",
      userId: "user1",
      user_role: "member",
      query: "pricing strategy",
    });

    const first = results[0];
    expect(first).toHaveProperty("chunk_id");
    expect(first).toHaveProperty("document_id");
    expect(first).toHaveProperty("metadata");
    expect(first).toHaveProperty("score");
    expect((first as any).content).toBeUndefined();
  });

  it("restricts cross-department search to super_user role", async () => {
    await expect(
      crossDeptVectorSearch({
        orgId: "org1",
        userId: "user1",
        user_role: "member",
        query: "revenue",
      })
    ).rejects.toThrow("cross-department search requires super_user or admin role");
  });

  it("allows super_user to retrieve cross-department data", async () => {
    const results = await crossDeptVectorSearch({
      orgId: "org1",
      userId: "analyst1",
      user_role: "super_user",
      query: "market revenue",
    });

    expect(results).toBeDefined();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk_id).toBe("chk_bi_1");
  });
});
