// ============================================================
// lib/integrations/powerbi/__tests__/reports-fetcher.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListWorkspaces = vi.fn();
const mockPowerbiFetchScoped = vi.fn();
const mockPowerbiFetch = vi.fn();
const mockGetSelectedResourceIds = vi.fn();
const mockGetExcludedResourceIds = vi.fn();

vi.mock("../client", () => ({
  powerbiFetch: (...args: unknown[]) => mockPowerbiFetch(...args),
  powerbiFetchScoped: (...args: unknown[]) => mockPowerbiFetchScoped(...args),
  listWorkspaces: (...args: unknown[]) => mockListWorkspaces(...args),
}));

vi.mock("../sync-config", () => ({
  getSelectedResourceIds: (...args: unknown[]) => mockGetSelectedResourceIds(...args),
  getExcludedResourceIds: (...args: unknown[]) => mockGetExcludedResourceIds(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: { department_id: "dept-1" } }),
        }),
      }),
    }),
  },
}));

import { fetchPowerBIContent } from "../reports-fetcher";

const workspace = { id: "ws-1", name: "Sales Workspace" };
const report = { id: "r-1", name: "Q1 Report", description: "Q1 overview", datasetId: "ds-1", webUrl: "https://app.powerbi.com/reports/r-1" };
const dataset = { id: "ds-1", name: "Sales Dataset", isRefreshable: true };
const dashboard = { id: "d-1", displayName: "Sales Dashboard", webUrl: "https://app.powerbi.com/dashboards/d-1" };

describe("fetchPowerBIContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSelectedResourceIds.mockReturnValue(null);
    mockGetExcludedResourceIds.mockReturnValue(new Set());
  });

  it("returns empty array when no workspaces exist", async () => {
    mockListWorkspaces.mockResolvedValue([]);
    // Legacy fallback also returns empty
    mockPowerbiFetch.mockResolvedValue({ value: [] });
    const result = await fetchPowerBIContent("conn-1", "org-1");
    expect(result).toEqual([]);
  });

  it("creates report chunks for each workspace report", async () => {
    mockListWorkspaces.mockResolvedValue([workspace]);
    mockPowerbiFetchScoped
      .mockResolvedValueOnce({ value: [report] })  // reports
      .mockResolvedValueOnce({ value: [{ name: "p1", displayName: "Page One" }] }) // pages
      .mockResolvedValueOnce({ value: [] })          // datasets
      .mockResolvedValueOnce({ value: [] });          // dashboards

    const result = await fetchPowerBIContent("conn-1", "org-1");

    const reportChunk = result.find((c) => c.chunk_id === "powerbi_report_r-1_ws_ws-1");
    expect(reportChunk).toBeDefined();
    expect(reportChunk?.title).toBe("Power BI Report: Q1 Report");
    expect(reportChunk?.content).toContain("Pages: Page One");
    expect(reportChunk?.content).toContain("Workspace: Sales Workspace");
    expect(reportChunk?.source_url).toBe("https://app.powerbi.com/reports/r-1");
    expect(reportChunk?.metadata?.provider).toBe("powerbi");
    expect(reportChunk?.metadata?.resource_type).toBe("report");
  });

  it("creates dataset chunks with schema content", async () => {
    mockListWorkspaces.mockResolvedValue([workspace]);
    mockPowerbiFetchScoped
      .mockResolvedValueOnce({ value: [] }) // reports
      .mockResolvedValueOnce({ value: [dataset] }) // datasets
      .mockResolvedValueOnce({
        value: [{ name: "orders", columns: [{ name: "id", dataType: "Int64" }, { name: "amount", dataType: "Decimal" }] }],
      }) // tables
      .mockResolvedValueOnce({ value: [] }) // measures
      .mockResolvedValueOnce({ value: [] }); // dashboards

    const result = await fetchPowerBIContent("conn-1", "org-1");

    const dsChunk = result.find((c) => c.chunk_id === "powerbi_dataset_ds-1_ws_ws-1");
    expect(dsChunk?.content).toContain("Table orders: id (Int64), amount (Decimal)");
    expect(dsChunk?.metadata?.resource_type).toBe("dataset");
  });

  it("creates DAX measure chunks for each measure in a dataset", async () => {
    mockListWorkspaces.mockResolvedValue([workspace]);
    const measure = { name: "Total Revenue", description: "Sum of all revenue", expression: "SUM(orders[amount])" };

    mockPowerbiFetchScoped
      .mockResolvedValueOnce({ value: [] }) // reports
      .mockResolvedValueOnce({ value: [dataset] }) // datasets
      .mockRejectedValueOnce(new Error("No tables")) // tables (non-fatal)
      .mockResolvedValueOnce({ value: [measure] }) // measures
      .mockResolvedValueOnce({ value: [] }); // dashboards

    const result = await fetchPowerBIContent("conn-1", "org-1");

    const measureChunk = result.find((c) => c.chunk_id?.includes("powerbi_measure_ds-1_Total_Revenue"));
    expect(measureChunk?.title).toBe("Power BI Measure: Total Revenue (Sales Dataset)");
    // P4-5: DAX is now wrapped in a fenced code block (fence-atomic + D8-safe).
    expect(measureChunk?.content).toContain("```dax\nSUM(orders[amount])\n```");
    expect(measureChunk?.metadata?.resource_type).toBe("powerbi_measure");
  });

  it("creates dashboard chunks", async () => {
    mockListWorkspaces.mockResolvedValue([workspace]);
    mockPowerbiFetchScoped
      .mockResolvedValueOnce({ value: [] }) // reports
      .mockResolvedValueOnce({ value: [] }) // datasets
      .mockResolvedValueOnce({ value: [dashboard] }); // dashboards

    const result = await fetchPowerBIContent("conn-1", "org-1");

    const dashChunk = result.find((c) => c.chunk_id === "powerbi_dashboard_d-1_ws_ws-1");
    expect(dashChunk?.title).toBe("Power BI Dashboard: Sales Dashboard");
    expect(dashChunk?.metadata?.resource_type).toBe("dashboard");
  });

  it("uses legacy endpoints when no workspaces are accessible", async () => {
    mockListWorkspaces.mockResolvedValue([]);
    mockPowerbiFetch
      .mockResolvedValueOnce({ value: [report] })   // legacy reports
      .mockResolvedValueOnce({ value: [dataset] })  // legacy datasets
      .mockResolvedValueOnce({ value: [] });          // legacy dashboards

    const result = await fetchPowerBIContent("conn-1", "org-1");

    expect(result.some((c) => c.chunk_id === "powerbi_report_r-1")).toBe(true);
  });

  it("excludes resources in excludedIds", async () => {
    mockGetExcludedResourceIds.mockReturnValue(new Set(["r-1"]));
    mockListWorkspaces.mockResolvedValue([workspace]);
    mockPowerbiFetchScoped
      .mockResolvedValueOnce({ value: [report] }) // reports
      .mockResolvedValueOnce({ value: [] })        // datasets
      .mockResolvedValueOnce({ value: [] });        // dashboards

    const result = await fetchPowerBIContent("conn-1", "org-1", { excludedResources: ["r-1"] } as any);

    expect(result.find((c) => c.chunk_id === "powerbi_report_r-1")).toBeUndefined();
  });
});
