// ============================================================
// lib/integrations/linear/__tests__/issues-fetcher.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLinearFetch = vi.fn();

vi.mock("../client", () => ({
  linearFetch: (...args: unknown[]) => mockLinearFetch(...args),
}));

import { linearIssuesFetcher } from "../issues-fetcher";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-uuid-1",
    identifier: "ENG-42",
    title: "Fix null pointer in auth",
    description: "When user logs out during session refresh...",
    url: "https://linear.app/acme/issue/ENG-42",
    priority: 1, // Urgent
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z",
    state: { name: "In Progress", type: "started" },
    assignee: { id: "user-uuid-alice", name: "Alice Smith" },
    project: { id: "proj-1", name: "Q2 Launch" },
    cycle: { id: "cycle-1", name: "Sprint 12" },
    team: { name: "Engineering", key: "ENG" },
    labels: { nodes: [{ name: "bug" }, { name: "auth" }] },
    comments: {
      nodes: [
        { body: "Reproduced on v2.3.", createdAt: "2026-05-02T00:00:00Z" },
      ],
    },
    ...overrides,
  };
}

function makePage(issues: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      issues: {
        pageInfo: { hasNextPage, endCursor },
        nodes: issues,
      },
    },
  };
}

describe("linearIssuesFetcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no issues exist", async () => {
    mockLinearFetch.mockResolvedValue(makePage([]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    expect(result).toEqual([]);
  });

  it("returns empty array when data.issues is missing", async () => {
    mockLinearFetch.mockResolvedValue({ data: {} });
    const result = await linearIssuesFetcher("conn-1", "org-1");
    expect(result).toEqual([]);
  });

  it("transforms a full issue into a FetchedChunk", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue()]));
    const result = await linearIssuesFetcher("conn-1", "org-1");

    expect(result).toHaveLength(1);
    const chunk = result[0];
    expect(chunk.chunk_id).toBe("issue-uuid-1");
    expect(chunk.title).toBe("ENG-42: Fix null pointer in auth");
    expect(chunk.source_url).toBe("https://linear.app/acme/issue/ENG-42");
    expect(chunk.metadata?.provider).toBe("linear");
    expect(chunk.metadata?.resource_type).toBe("issue");
  });

  it("maps priority number 1 to Urgent label", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue({ priority: 1 })]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    expect(result[0].content).toContain("Priority: Urgent");
    expect(result[0].metadata?.priority).toBe("Urgent");
  });

  it("maps priority number 2 to High label", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue({ priority: 2 })]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    expect(result[0].content).toContain("Priority: High");
  });

  it("maps priority number 0 to No priority", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue({ priority: 0 })]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    expect(result[0].content).toContain("Priority: No priority");
  });

  it("includes team, assignee, and labels in content", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue()]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    const content = result[0].content;
    expect(content).toContain("Team: Engineering");
    expect(content).toContain("Assignee: Alice Smith");
    expect(content).toContain("Labels: bug, auth");
  });

  it("includes comments in content", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue()]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    expect(result[0].content).toContain("Reproduced on v2.3.");
  });

  it("handles issue with no assignee, team, or labels", async () => {
    const minimal = makeIssue({
      assignee: null,
      team: null,
      labels: { nodes: [] },
      comments: { nodes: [] },
      description: null,
    });
    mockLinearFetch.mockResolvedValue(makePage([minimal]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    expect(result).toHaveLength(1);
    expect(result[0].content).not.toContain("Team:");
    expect(result[0].content).not.toContain("Assignee:");
  });

  it("emits structured_owners WORKS_ON for assignee with provider_account_id", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue()]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    const owners = result[0].structured_owners ?? [];
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ person_label: "Alice Smith", provider_account_id: "user-uuid-alice", relation: "WORKS_ON" });
  });

  it("emits no structured_owners when assignee is null", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue({ assignee: null })]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    expect(result[0].structured_owners).toBeUndefined();
  });

  it("emits PART_OF structured_link for project", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue()]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    const links = (result[0].metadata?.structured_links ?? []) as any[];
    const partOf = links.filter((l) => l.relation === "PART_OF");
    expect(partOf.some((l) => l.target_label === "Q2 Launch")).toBe(true);
  });

  it("emits PART_OF structured_link for cycle", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue()]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    const links = (result[0].metadata?.structured_links ?? []) as any[];
    const cycleLink = links.find((l) => l.relation === "PART_OF" && l.target_label === "Sprint 12");
    expect(cycleLink).toBeDefined();
  });

  it("emits no PART_OF link when project and cycle are null", async () => {
    mockLinearFetch.mockResolvedValue(makePage([makeIssue({ project: null, cycle: null })]));
    const result = await linearIssuesFetcher("conn-1", "org-1");
    const links = (result[0].metadata?.structured_links ?? []) as any[];
    expect(links.filter((l) => l.relation === "PART_OF")).toHaveLength(0);
  });

  it("paginates until hasNextPage is false", async () => {
    mockLinearFetch
      .mockResolvedValueOnce(makePage([makeIssue({ id: "i-1" })], true, "cursor-abc"))
      .mockResolvedValueOnce(makePage([makeIssue({ id: "i-2" })], false));

    const result = await linearIssuesFetcher("conn-1", "org-1");

    expect(result).toHaveLength(2);
    expect(mockLinearFetch).toHaveBeenCalledTimes(2);
    const secondCallVars = mockLinearFetch.mock.calls[1][3];
    expect(secondCallVars.cursor).toBe("cursor-abc");
  });
});
