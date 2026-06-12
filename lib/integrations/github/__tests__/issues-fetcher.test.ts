// ============================================================
// lib/integrations/github/__tests__/issues-fetcher.test.ts
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGithubFetch = vi.fn();

vi.mock("../client", () => ({
  githubFetch: (...args: unknown[]) => mockGithubFetch(...args),
}));

import { githubIssuesFetcher } from "../issues-fetcher";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    number: 1,
    title: "Bug: login fails",
    body: "Steps to reproduce...",
    url: "https://github.com/org/repo/issues/1",
    state: "OPEN",
    createdAt: "2026-05-01T00:00:00Z",
    comments: { nodes: [{ body: "Confirmed." }, { body: "Fixed in v2." }] },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

function makePage(issues: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage, endCursor },
          nodes: issues,
        },
      },
    },
  };
}

describe("githubIssuesFetcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when repository has no issues", async () => {
    mockGithubFetch.mockResolvedValue(makePage([]));
    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");
    expect(result).toEqual([]);
  });

  it("returns empty array when repository object is missing", async () => {
    mockGithubFetch.mockResolvedValue({ data: {} });
    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");
    expect(result).toEqual([]);
  });

  it("transforms a single issue into a FetchedChunk", async () => {
    mockGithubFetch.mockResolvedValue(makePage([makeIssue()]));
    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");

    expect(result).toHaveLength(1);
    expect(result[0].chunk_id).toBe("issue-1");
    expect(result[0].title).toBe("Bug: login fails");
    expect(result[0].source_url).toBe("https://github.com/org/repo/issues/1");
    expect(result[0].metadata?.provider).toBe("github");
    expect(result[0].metadata?.resource_type).toBe("issue");
  });

  it("concatenates issue body and comments into content", async () => {
    mockGithubFetch.mockResolvedValue(makePage([makeIssue()]));
    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");

    expect(result[0].content).toContain("Bug: login fails");
    expect(result[0].content).toContain("Steps to reproduce");
    expect(result[0].content).toContain("Confirmed.");
    expect(result[0].content).toContain("Fixed in v2.");
  });

  it("handles issue with no comments gracefully", async () => {
    const issue = makeIssue({ comments: { nodes: [] } });
    mockGithubFetch.mockResolvedValue(makePage([issue]));
    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Bug: login fails");
  });

  it("paginates until hasNextPage is false", async () => {
    mockGithubFetch
      .mockResolvedValueOnce(makePage([makeIssue({ id: "i-1", title: "Issue 1" })], true, "cursor-1"))
      .mockResolvedValueOnce(makePage([makeIssue({ id: "i-2", title: "Issue 2" })], false));

    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");

    expect(result).toHaveLength(2);
    expect(mockGithubFetch).toHaveBeenCalledTimes(2);
    const secondCallVars = mockGithubFetch.mock.calls[1][3];
    expect(secondCallVars.cursor).toBe("cursor-1");
  });

  it("emits structured_owners for author (REPORTED_BY) and assignees (WORKS_ON)", async () => {
    const issue = makeIssue({
      author: { login: "alice" },
      assignees: { nodes: [{ login: "bob" }, { login: "carol" }] },
    });
    mockGithubFetch.mockResolvedValue(makePage([issue]));
    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");
    const owners = result[0].structured_owners ?? [];
    expect(owners).toHaveLength(3);
    expect(owners.find(o => o.relation === "REPORTED_BY")).toMatchObject({ person_label: "alice", provider_account_id: "alice" });
    expect(owners.filter(o => o.relation === "WORKS_ON").map(o => o.person_label)).toEqual(["bob", "carol"]);
  });

  it("emits no structured_owners when author and assignees are absent", async () => {
    const issue = makeIssue({ author: null, assignees: { nodes: [] } });
    mockGithubFetch.mockResolvedValue(makePage([issue]));
    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");
    expect(result[0].structured_owners).toBeUndefined();
  });

  it("emits structured_links for timeline cross-references", async () => {
    const issue = makeIssue({
      timelineItems: {
        nodes: [
          { source: { number: 99, title: "Fix for bug", url: "https://github.com/org/repo/pull/99" } },
        ],
      },
    });
    mockGithubFetch.mockResolvedValue(makePage([issue]));
    const result = await githubIssuesFetcher("conn-1", "org-1", "myorg", "myrepo");
    const links = result[0].metadata?.structured_links as any[];
    expect(links).toBeDefined();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ relation: "RELATED_TO", target_label: "#99: Fix for bug" });
  });

  it("passes owner and repo to the GraphQL query variables", async () => {
    mockGithubFetch.mockResolvedValue(makePage([]));
    await githubIssuesFetcher("conn-1", "org-1", "acme-corp", "backend-api");

    const vars = mockGithubFetch.mock.calls[0][3];
    expect(vars.owner).toBe("acme-corp");
    expect(vars.repo).toBe("backend-api");
  });
});
