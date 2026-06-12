// ============================================================
// lib/integrations/redshift/__tests__/tables-fetcher.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRedshiftCredentials = vi.fn();
const mockRedshiftQuery = vi.fn();

vi.mock("../client", () => ({
  getRedshiftCredentials: (...args: unknown[]) => mockGetRedshiftCredentials(...args),
  redshiftQuery: (...args: unknown[]) => mockRedshiftQuery(...args),
}));

vi.mock("../../bi-chunking", () => ({
  buildStatsChunk: vi.fn().mockImplementation((name: string) => ({ chunk_id: `stats_${name}`, title: `Stats: ${name}` })),
  buildSampleChunk: vi.fn().mockImplementation((name: string) => ({ chunk_id: `sample_${name}`, title: `Sample: ${name}` })),
  buildAggregationChunk: vi.fn().mockImplementation((name: string) => ({ chunk_id: `agg_${name}`, title: `Agg: ${name}` })),
  classifyColumn: vi.fn().mockReturnValue("categorical"),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { fetchRedshiftTables } from "../tables-fetcher";

const baseCreds = {
  clusterId: "my-cluster",
  database: "analytics",
  allowlist: [] as string[],
  host: "my-cluster.us-east-1.redshift.amazonaws.com",
  port: 5439,
  user: "admin",
  region: "us-east-1",
};

describe("fetchRedshiftTables", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRedshiftCredentials.mockResolvedValue(baseCreds);
  });

  it("returns empty array when table discovery returns no tables", async () => {
    mockRedshiftQuery.mockResolvedValue([]); // discoverTables returns empty
    const result = await fetchRedshiftTables("conn-1", "org-1");
    expect(result).toEqual([]);
  });

  it("uses allowlist from credentials when provided", async () => {
    const creds = { ...baseCreds, allowlist: ["public.orders"] };
    mockGetRedshiftCredentials.mockResolvedValue(creds);

    mockRedshiftQuery
      .mockResolvedValueOnce([{ column_name: "id", data_type: "integer" }, { column_name: "amount", data_type: "numeric" }]) // schema
      .mockResolvedValueOnce([{ row_count: 1000 }])   // count
      .mockResolvedValue([]);                           // stats and sample queries

    const result = await fetchRedshiftTables("conn-1", "org-1");
    // Should process public.orders
    expect(result.some((c) => c.chunk_id?.includes("public.orders"))).toBe(true);
  });

  it("skips tables with invalid identifiers (SQL injection guard)", async () => {
    const creds = { ...baseCreds, allowlist: ["public.orders; DROP TABLE users;--"] };
    mockGetRedshiftCredentials.mockResolvedValue(creds);

    const result = await fetchRedshiftTables("conn-1", "org-1");
    expect(result).toHaveLength(0);
  });

  it("skips tables with empty schema", async () => {
    const creds = { ...baseCreds, allowlist: ["public.empty_table"] };
    mockGetRedshiftCredentials.mockResolvedValue(creds);

    mockRedshiftQuery.mockResolvedValue([]); // empty schema

    const result = await fetchRedshiftTables("conn-1", "org-1");
    expect(result).toHaveLength(0);
  });

  it("continues processing other tables when one table fails (fault tolerance)", async () => {
    const creds = { ...baseCreds, allowlist: ["public.orders", "public.customers"] };
    mockGetRedshiftCredentials.mockResolvedValue(creds);

    mockRedshiftQuery
      .mockRejectedValueOnce(new Error("permission denied on public.orders")) // orders schema fails
      .mockResolvedValueOnce([{ column_name: "id", data_type: "integer" }])   // customers schema
      .mockResolvedValueOnce([{ row_count: 500 }])   // customers count
      .mockResolvedValue([]);                          // stats/sample queries

    const result = await fetchRedshiftTables("conn-1", "org-1");
    expect(result.some((c) => c.chunk_id?.includes("public.customers"))).toBe(true);
  });

  it("skips sync entirely when allowlist is empty (no accidental full-schema indexing)", async () => {
    // Auto-discovery was removed: an empty allowlist must not scan
    // information_schema — it could index sensitive tables. The fetcher
    // returns [] and never touches the warehouse.
    mockGetRedshiftCredentials.mockResolvedValue({ ...baseCreds, allowlist: [] });

    const result = await fetchRedshiftTables("conn-1", "org-1");

    expect(result).toEqual([]);
    expect(mockRedshiftQuery).not.toHaveBeenCalled();
  });
});
