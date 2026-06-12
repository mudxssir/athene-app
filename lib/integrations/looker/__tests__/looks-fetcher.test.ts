// ============================================================
// lib/integrations/looker/__tests__/looks-fetcher.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLookerFetch = vi.fn();
const mockLookerInstanceUrl = vi.fn();

vi.mock("../client", () => ({
  lookerFetch: (...args: unknown[]) => mockLookerFetch(...args),
  lookerInstanceUrl: (...args: unknown[]) => mockLookerInstanceUrl(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { fetchLookerContent } from "../looks-fetcher";

describe("fetchLookerContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLookerInstanceUrl.mockResolvedValue("https://acme.looker.com");
  });

  it("returns empty array when looks and dashboards are empty", async () => {
    mockLookerFetch.mockResolvedValue([]);
    const result = await fetchLookerContent("conn-1", "org-1");
    expect(result).toEqual([]);
  });

  it("creates a chunk for each look with run data", async () => {
    const looks = [{ id: 1, title: "Revenue Trend", description: "Monthly revenue", short_url: "/1" }];
    const lookData = [{ "orders.total": "1000", "orders.month": "2026-05" }];

    // Looks and dashboards are fetched in parallel — mock by path, not call order
    mockLookerFetch.mockImplementation(async (_conn: unknown, _org: unknown, path: unknown) => {
      const p = String(path);
      if (p.startsWith("/looks?")) return looks;
      if (p.includes("/run/json")) return lookData;
      if (p.startsWith("/dashboards")) return [];
      return [];
    });

    const result = await fetchLookerContent("conn-1", "org-1");

    const lookChunk = result.find((c) => c.chunk_id === "looker_look_1");
    expect(lookChunk).toBeDefined();
    expect(lookChunk?.title).toBe("Looker Look: Revenue Trend");
    expect(lookChunk?.content).toContain("Monthly revenue");
    expect(lookChunk?.content).toContain("orders.total: 1000");
    expect(lookChunk?.source_url).toBe("https://acme.looker.com/looks/1");
    expect(lookChunk?.metadata?.provider).toBe("looker");
    expect(lookChunk?.metadata?.resource_type).toBe("look");
  });

  it("falls back to metadata-only chunk when look run fails", async () => {
    const looks = [{ id: 2, title: "Parameterized Look", description: "Needs params", short_url: "/2" }];

    mockLookerFetch
      .mockResolvedValueOnce(looks)
      .mockRejectedValueOnce(new Error("Required parameter missing"))
      .mockResolvedValueOnce([]);

    const result = await fetchLookerContent("conn-1", "org-1");

    const lookChunk = result.find((c) => c.chunk_id === "looker_look_2");
    expect(lookChunk).toBeDefined();
    expect(lookChunk?.content).toBe("Needs params"); // description as content
  });

  it("uses title as fallback when look description and run data are empty", async () => {
    const looks = [{ id: 3, title: "Empty Look", description: null, short_url: "/3" }];

    mockLookerFetch.mockImplementation(async (_conn: unknown, _org: unknown, path: unknown) => {
      const p = String(path);
      if (p.startsWith("/looks?")) return looks;
      if (p.includes("/run/json")) return [];   // run succeeds with zero rows
      return [];
    });

    const result = await fetchLookerContent("conn-1", "org-1");

    const lookChunk = result.find((c) => c.chunk_id === "looker_look_3");
    expect(lookChunk?.content).toBe("Empty Look");
  });

  it("creates chunks for dashboards", async () => {
    const dashboards = [{ id: "dash-1", title: "Sales Dashboard", description: "Q1 Sales overview" }];

    mockLookerFetch
      .mockResolvedValueOnce([])          // looks
      .mockResolvedValueOnce(dashboards); // dashboards

    const result = await fetchLookerContent("conn-1", "org-1");

    const dashChunk = result.find((c) => c.chunk_id === "looker_dashboard_dash-1");
    expect(dashChunk?.title).toBe("Looker Dashboard: Sales Dashboard");
    expect(dashChunk?.content).toBe("Q1 Sales overview");
    expect(dashChunk?.metadata?.resource_type).toBe("dashboard");
  });

  it("continues processing dashboards when looks endpoint fails", async () => {
    const dashboards = [{ id: "d-2", title: "Finance Dashboard", description: null }];

    mockLookerFetch
      .mockRejectedValueOnce(new Error("Looks API down"))
      .mockResolvedValueOnce(dashboards);

    const result = await fetchLookerContent("conn-1", "org-1");

    expect(result.some((c) => c.chunk_id === "looker_dashboard_d-2")).toBe(true);
  });
});
