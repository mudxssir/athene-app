// ============================================================
// tests/security/graph/structured-owner-visibility.test.ts (P2-5)
//
// Verifies that structured work-graph edges (OWNS, WORKS_ON,
// BLOCKS, BLOCKED_BY) emitted with org_wide visibility are
// accessible by members from any department.
// ============================================================

import { describe, it, expect } from "vitest";
import { buildStructuredOwnerGraph } from "@/lib/knowledge-graph/structured-owners";
import { buildStructuredLinkGraph } from "@/lib/knowledge-graph/structured-links";

const BASE_DOC = {
  id: "doc-1",
  org_id: "org-1",
  title: "ENG-42: Fix login",
  department_id: "dept-engineering",
  visibility: "department", // doc itself is dept-scoped
  metadata: {
    provider: "linear",
    resource_type: "issue",
    structured_owners: [
      { person_label: "Alice", provider_account_id: "alice-id", relation: "OWNS" },
      { person_label: "Bob", provider_account_id: "bob-id", relation: "WORKS_ON" },
    ],
    structured_links: [
      { relation: "BLOCKS", target_label: "OPS-7: Deploy pipeline" },
    ],
  },
};

describe("structured work-graph edge visibility (P2-5)", () => {
  it("buildStructuredOwnerGraph emits org_wide nodes and edges", () => {
    const { nodes, edges } = buildStructuredOwnerGraph(BASE_DOC);
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);
    nodes.forEach((n) =>
      expect(n.visibility).toBe("org_wide"),
    );
    edges.forEach((e) =>
      expect(e.visibility).toBe("org_wide"),
    );
  });

  it("buildStructuredLinkGraph emits org_wide nodes and edges", () => {
    const { nodes, edges } = buildStructuredLinkGraph(BASE_DOC);
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBeGreaterThan(0);
    nodes.forEach((n) =>
      expect(n.visibility).toBe("org_wide"),
    );
    edges.forEach((e) =>
      expect(e.visibility).toBe("org_wide"),
    );
  });

  it("visibility stays org_wide even when document is private-scoped", () => {
    const privateDoc = { ...BASE_DOC, visibility: "private" };
    const ownerResult = buildStructuredOwnerGraph(privateDoc);
    const linkResult = buildStructuredLinkGraph(privateDoc);
    [...ownerResult.nodes, ...ownerResult.edges].forEach((item) =>
      expect(item.visibility).toBe("org_wide"),
    );
    [...linkResult.nodes, ...linkResult.edges].forEach((item) =>
      expect(item.visibility).toBe("org_wide"),
    );
  });

  it("owner edges from dept-engineering are accessible to dept-product member", () => {
    // This unit test verifies the field value — the actual DB policy is integration-tested.
    // A dept-product user can query kg_nodes/kg_edges WHERE visibility = 'org_wide'.
    const { edges } = buildStructuredOwnerGraph(BASE_DOC);
    const ownsEdge = edges.find((e) => e.relation === "OWNS");
    expect(ownsEdge).toBeDefined();
    expect(ownsEdge!.visibility).toBe("org_wide");
    // Any org member can query this edge in the DB since visibility = 'org_wide'
    // (enforced by kg_edges RLS policy: visible when visibility = 'org_wide' OR dept match)
  });
});
