// ============================================================
// lib/integrations/tableau/__tests__/workbooks-fetcher.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTableauSignIn = vi.fn();
const mockTableauFetch = vi.fn();

vi.mock("../client", () => ({
  tableauSignIn: (...args: unknown[]) => mockTableauSignIn(...args),
  tableauFetch: (...args: unknown[]) => mockTableauFetch(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { fetchTableauWorkbooks } from "../workbooks-fetcher";

const session = {
  token: "tok-abc",
  siteId: "site-1",
  serverUrl: "https://tableau.acme.com",
};

function makeWorkbook(overrides: Record<string, unknown> = {}) {
  return {
    id: "wb-1",
    name: "Sales Analysis",
    description: "Quarterly sales breakdown",
    webpageUrl: "https://tableau.acme.com/#/workbooks/wb-1",
    project: { id: "proj-1", name: "Finance" },
    ...overrides,
  };
}

function makeView(overrides: Record<string, unknown> = {}) {
  return {
    id: "view-1",
    name: "Revenue by Region",
    contentUrl: "SalesAnalysis/sheets/RevenueByRegion",
    ...overrides,
  };
}

describe("fetchTableauWorkbooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTableauSignIn.mockResolvedValue(session);
  });

  it("returns empty array when no workbooks exist", async () => {
    mockTableauFetch.mockResolvedValue({ workbooks: { workbook: [] } });
    const result = await fetchTableauWorkbooks("conn-1", "org-1");
    expect(result).toEqual([]);
  });

  it("returns empty array when workbooks fetch fails", async () => {
    mockTableauFetch.mockRejectedValue(new Error("Auth failed"));
    const result = await fetchTableauWorkbooks("conn-1", "org-1");
    expect(result).toEqual([]);
  });

  it("creates a workbook chunk with description, views, and project", async () => {
    const views = [makeView(), makeView({ id: "view-2", name: "Margin Trends" })];

    mockTableauFetch
      .mockResolvedValueOnce({ workbooks: { workbook: [makeWorkbook()] } })
      .mockResolvedValueOnce({ views: { view: views } });

    const result = await fetchTableauWorkbooks("conn-1", "org-1");

    const wbChunk = result.find((c) => c.chunk_id === "tableau_workbook_wb-1");
    expect(wbChunk).toBeDefined();
    expect(wbChunk?.title).toBe("Tableau: Sales Analysis");
    expect(wbChunk?.content).toContain("Quarterly sales breakdown");
    expect(wbChunk?.content).toContain("Views: Revenue by Region, Margin Trends");
    expect(wbChunk?.content).toContain("Project: Finance");
    expect(wbChunk?.source_url).toBe("https://tableau.acme.com/#/workbooks/wb-1");
    expect(wbChunk?.metadata?.provider).toBe("tableau");
    expect(wbChunk?.metadata?.resource_type).toBe("workbook");
    expect(wbChunk?.metadata?.view_count).toBe("2");
  });

  it("creates individual view chunks for each view", async () => {
    const view = makeView();
    mockTableauFetch
      .mockResolvedValueOnce({ workbooks: { workbook: [makeWorkbook()] } })
      .mockResolvedValueOnce({ views: { view: [view] } });

    const result = await fetchTableauWorkbooks("conn-1", "org-1");

    const viewChunk = result.find((c) => c.chunk_id === "tableau_view_view-1");
    expect(viewChunk).toBeDefined();
    expect(viewChunk?.title).toBe("Tableau View: Revenue by Region (Sales Analysis)");
    expect(viewChunk?.content).toContain("Revenue by Region");
    expect(viewChunk?.content).toContain("Sales Analysis");
    expect(viewChunk?.metadata?.resource_type).toBe("view");
    expect(viewChunk?.metadata?.workbook_id).toBe("wb-1");
  });

  it("processes workbook without views when view fetch fails (non-fatal)", async () => {
    mockTableauFetch
      .mockResolvedValueOnce({ workbooks: { workbook: [makeWorkbook()] } })
      .mockRejectedValueOnce(new Error("Views not accessible"));

    const result = await fetchTableauWorkbooks("conn-1", "org-1");

    // Workbook chunk still created, no view chunks
    const wbChunk = result.find((c) => c.chunk_id === "tableau_workbook_wb-1");
    expect(wbChunk).toBeDefined();
    const viewChunks = result.filter((c) => c.metadata?.resource_type === "view");
    expect(viewChunks).toHaveLength(0);
  });

  it("handles workbook with no description", async () => {
    const wb = makeWorkbook({ description: "" });
    mockTableauFetch
      .mockResolvedValueOnce({ workbooks: { workbook: [wb] } })
      .mockResolvedValueOnce({ views: { view: [] } });

    const result = await fetchTableauWorkbooks("conn-1", "org-1");
    const wbChunk = result.find((c) => c.chunk_id === "tableau_workbook_wb-1");
    expect(wbChunk).toBeDefined();
    // Content should still be valid (just project line)
    expect(wbChunk?.content).toContain("Project: Finance");
  });

  it("processes multiple workbooks", async () => {
    const wb2 = makeWorkbook({ id: "wb-2", name: "HR Dashboard" });
    mockTableauFetch
      .mockResolvedValueOnce({ workbooks: { workbook: [makeWorkbook(), wb2] } })
      .mockResolvedValueOnce({ views: { view: [] } })
      .mockResolvedValueOnce({ views: { view: [] } });

    const result = await fetchTableauWorkbooks("conn-1", "org-1");

    expect(result.some((c) => c.chunk_id === "tableau_workbook_wb-1")).toBe(true);
    expect(result.some((c) => c.chunk_id === "tableau_workbook_wb-2")).toBe(true);
  });
});
