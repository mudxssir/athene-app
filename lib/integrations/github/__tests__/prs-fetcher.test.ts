// ============================================================
// lib/integrations/github/__tests__/prs-fetcher.test.ts (P2-6)
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGithubFetch = vi.fn();
vi.mock("../client", () => ({
  githubFetch: (...args: unknown[]) => mockGithubFetch(...args),
}));

import { githubPrsFetcher } from "../prs-fetcher";

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    id: "pr-1",
    title: "feat: add login",
    body: "Adds login flow.",
    url: "https://github.com/org/repo/pull/1",
    createdAt: "2026-05-01T00:00:00Z",
    state: "OPEN",
    mergedAt: null,
    author: { login: "alice" },
    assignees: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    closingIssuesReferences: { nodes: [] },
    ...overrides,
  };
}

function makePage(prs: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage, endCursor },
          nodes: prs,
        },
      },
    },
  };
}

describe("githubPrsFetcher (P2-6)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty array when no PRs", async () => {
    mockGithubFetch.mockResolvedValue(makePage([]));
    expect(await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo")).toEqual([]);
  });

  it("emits author as OWNS structured_owner", async () => {
    mockGithubFetch.mockResolvedValue(makePage([makePR()]));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    const owners = result[0].structured_owners ?? [];
    expect(owners.find(o => o.relation === "OWNS")).toMatchObject({ person_label: "alice", provider_account_id: "alice" });
  });

  it("emits assignees as WORKS_ON structured_owners", async () => {
    const pr = makePR({ assignees: { nodes: [{ login: "bob" }] } });
    mockGithubFetch.mockResolvedValue(makePage([pr]));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    const owners = result[0].structured_owners ?? [];
    expect(owners.find(o => o.relation === "WORKS_ON")).toMatchObject({ person_label: "bob" });
  });

  it("emits requested reviewers as WORKS_ON structured_owners", async () => {
    const pr = makePR({
      reviewRequests: { nodes: [{ requestedReviewer: { login: "carol" } }, { requestedReviewer: {} }] },
    });
    mockGithubFetch.mockResolvedValue(makePage([pr]));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    const owners = result[0].structured_owners ?? [];
    expect(owners.find(o => o.relation === "WORKS_ON")).toMatchObject({ person_label: "carol" });
  });

  it("dedups a login that is both assignee and requested reviewer", async () => {
    const pr = makePR({
      assignees: { nodes: [{ login: "bob" }] },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "bob" } }] },
    });
    mockGithubFetch.mockResolvedValue(makePage([pr]));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    const worksOn = (result[0].structured_owners ?? []).filter(o => o.relation === "WORKS_ON");
    expect(worksOn).toHaveLength(1);
  });

  it("includes review bodies in content", async () => {
    const pr = makePR({ reviews: { nodes: [{ body: "LGTM", author: { login: "carol" } }] } });
    mockGithubFetch.mockResolvedValue(makePage([pr]));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    expect(result[0].content).toContain("LGTM");
  });

  it("includes inline review thread comments in content", async () => {
    const pr = makePR({
      reviewThreads: {
        nodes: [
          {
            comments: {
              nodes: [{ body: "Nit: rename this var", author: { login: "dave" } }],
            },
          },
        ],
      },
    });
    mockGithubFetch.mockResolvedValue(makePage([pr]));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    expect(result[0].content).toContain("Nit: rename this var");
    expect(result[0].content).toContain("Review Comments:");
  });

  it("emits RESOLVES structured_link for closingIssuesReferences", async () => {
    const pr = makePR({
      closingIssuesReferences: { nodes: [{ number: 42, title: "Bug: crash" }] },
    });
    mockGithubFetch.mockResolvedValue(makePage([pr]));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    const links = result[0].metadata?.structured_links as any[];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ relation: "RESOLVES", target_label: "#42: Bug: crash" });
  });

  it("includes mergedAt and state in metadata", async () => {
    const pr = makePR({ state: "MERGED", mergedAt: "2026-05-10T12:00:00Z" });
    mockGithubFetch.mockResolvedValue(makePage([pr]));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    expect(result[0].metadata?.state).toBe("MERGED");
    expect(result[0].metadata?.merged_at).toBe("2026-05-10T12:00:00Z");
  });

  it("paginates until hasNextPage is false", async () => {
    mockGithubFetch
      .mockResolvedValueOnce(makePage([makePR({ id: "pr-1" })], true, "cur-1"))
      .mockResolvedValueOnce(makePage([makePR({ id: "pr-2" })], false));
    const result = await githubPrsFetcher("conn-1", "org-1", "myorg", "myrepo");
    expect(result).toHaveLength(2);
    expect(mockGithubFetch).toHaveBeenCalledTimes(2);
  });
});
