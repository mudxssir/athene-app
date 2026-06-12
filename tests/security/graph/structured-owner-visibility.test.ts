// ============================================================
// tests/security/graph/structured-owner-visibility.test.ts (P2-5)
//
// Verifies the playbook's visibility SPLIT for structured work-graph
// output (item 5):
//   - LINK edges (BLOCKS/BLOCKED_BY/PART_OF/RELATED_TO/RESOLVES) are
//     org_wide — cross-functional blocker chains must cross dept walls.
//   - OWNER edges (OWNS/WORKS_ON/REPORTED_BY) INHERIT the document's
//     visibility — "ownership is org-readable only via item". Who is
//     assigned to a dept-scoped ticket must not leak org-wide.
//   - PERSON nodes are org_wide (existence is not sensitive; one node
//     per human enables cross-dept dedup), but the work-item node and
//     its owner edges carry the document's scope.
//
// Cross-dept scenario (member in dept X sees blocker chain into dept Y
// labels, cannot read dept Y document content) is encoded as field-level
// assertions here; the DB-policy half lives in the kg_edges RLS policies.
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

describe("structured work-graph visibility split (P2-5)", () => {
  // ── Link edges: org_wide (cross-functional blocker chains) ──────────

  it("link edges (BLOCKS) are org_wide regardless of document scope", () => {
    const { nodes, edges } = buildStructuredLinkGraph(BASE_DOC);
    expect(edges.length).toBeGreaterThan(0);
    nodes.forEach((n) => expect(n.visibility).toBe("org_wide"));
    edges.forEach((e) => expect(e.visibility).toBe("org_wide"));
  });

  it("link edges stay org_wide even for a private-scoped document", () => {
    const privateDoc = { ...BASE_DOC, visibility: "private" };
    const { edges } = buildStructuredLinkGraph(privateDoc);
    edges.forEach((e) => expect(e.visibility).toBe("org_wide"));
  });

  // ── Owner edges: inherit document visibility ─────────────────────────

  it("owner edges inherit the document's department visibility", () => {
    const { edges } = buildStructuredOwnerGraph(BASE_DOC);
    expect(edges.length).toBe(2);
    edges.forEach((e) => expect(e.visibility).toBe("department"));
  });

  it("owner edges on a private document stay private — assignment never leaks", () => {
    // HR complaint / security incident scenario: the fact that Alice is
    // assigned must not be org-readable when the ticket itself is not.
    const privateDoc = { ...BASE_DOC, visibility: "restricted" };
    const { nodes, edges } = buildStructuredOwnerGraph(privateDoc);
    edges.forEach((e) => expect(e.visibility).toBe("restricted"));
    const itemNode = nodes.find((n) => n.entity_type !== "person");
    expect(itemNode).toBeDefined();
    expect(itemNode!.visibility).toBe("restricted");
  });

  it("defaults owner-edge visibility to department when document visibility is null", () => {
    const nullVisDoc = { ...BASE_DOC, visibility: null };
    const { edges } = buildStructuredOwnerGraph(nullVisDoc);
    edges.forEach((e) => expect(e.visibility).toBe("department"));
  });

  // ── Person nodes: org_wide (dedup across departments) ───────────────

  it("person nodes are org_wide so one human resolves to one node org-wide", () => {
    const { nodes } = buildStructuredOwnerGraph(BASE_DOC);
    const personNodes = nodes.filter((n) => n.entity_type === "person");
    expect(personNodes.length).toBe(2);
    personNodes.forEach((n) => expect(n.visibility).toBe("org_wide"));
  });

  // ── Cross-dept scenario (field-level half) ───────────────────────────

  it("dept-product member sees the blocker chain INTO dept-engineering, not its ownership", () => {
    // The blocker chain (link edges) is org_wide → visible across depts.
    const linkEdges = buildStructuredLinkGraph(BASE_DOC).edges;
    const blocks = linkEdges.find((e) => e.relation === "BLOCKS");
    expect(blocks).toBeDefined();
    expect(blocks!.visibility).toBe("org_wide");

    // The ownership of the dept-scoped item is NOT org_wide → a dept-product
    // member's kg_edges RLS query (org_wide OR own-dept) excludes it.
    const ownerEdges = buildStructuredOwnerGraph(BASE_DOC).edges;
    const owns = ownerEdges.find((e) => e.relation === "OWNS");
    expect(owns).toBeDefined();
    expect(owns!.visibility).toBe("department");
    expect(owns!.department_id).toBe("dept-engineering");
  });
});
