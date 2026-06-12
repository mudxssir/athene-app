// ============================================================
// lib/knowledge-graph/__tests__/structured-owners.test.ts (P2-3)
// ============================================================

import { describe, it, expect } from "vitest";
import { buildStructuredOwnerGraph } from "../structured-owners";

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    org_id: "org-1",
    title: "ENG-42: Fix login",
    department_id: "dept-1",
    visibility: "department",
    metadata: {
      provider: "linear",
      resource_type: "issue",
      ...overrides,
    },
  };
}

describe("buildStructuredOwnerGraph", () => {
  it("returns empty result when no structured_owners in metadata", () => {
    const result = buildStructuredOwnerGraph(makeDoc());
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("returns empty result when title is blank", () => {
    const doc = { ...makeDoc(), title: "" };
    const result = buildStructuredOwnerGraph(doc);
    expect(result.nodes).toEqual([]);
  });

  it("creates a person node and OWNS edge for a single assignee", () => {
    const doc = makeDoc({
      structured_owners: [
        { person_label: "Alice", provider_account_id: "acc-1", relation: "OWNS" },
      ],
    });
    const { nodes, edges } = buildStructuredOwnerGraph(doc);

    const person = nodes.find((n) => n.entity_type === "person");
    expect(person).toBeDefined();
    expect(person!.label).toBe("Alice");
    expect(person!.metadata?.provider_account_id).toBe("acc-1");

    const workItem = nodes.find((n) => n.entity_type === "ticket");
    expect(workItem).toBeDefined();
    expect(workItem!.label).toBe("ENG-42: Fix login");

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source_label: "Alice",
      source_entity_type: "person",
      target_label: "ENG-42: Fix login",
      target_entity_type: "ticket",
      relation: "OWNS",
      provenance: "EXTRACTED",
      confidence: 1.0,
    });
  });

  it("creates REPORTED_BY and WORKS_ON edges for multiple owners", () => {
    const doc = makeDoc({
      structured_owners: [
        { person_label: "Alice", provider_account_id: "acc-1", relation: "REPORTED_BY" },
        { person_label: "Bob", provider_account_id: "acc-2", relation: "WORKS_ON" },
      ],
    });
    const { nodes, edges } = buildStructuredOwnerGraph(doc);

    expect(nodes.filter((n) => n.entity_type === "person")).toHaveLength(2);
    expect(edges.map((e) => e.relation)).toEqual(["REPORTED_BY", "WORKS_ON"]);
  });

  it("deduplicates person nodes for the same person_label", () => {
    const doc = makeDoc({
      structured_owners: [
        { person_label: "Alice", provider_account_id: "acc-1", relation: "OWNS" },
        { person_label: "Alice", provider_account_id: "acc-1", relation: "WORKS_ON" },
      ],
    });
    const { nodes, edges } = buildStructuredOwnerGraph(doc);

    const persons = nodes.filter((n) => n.entity_type === "person");
    expect(persons).toHaveLength(1);
    expect(edges).toHaveLength(2);
  });

  it("skips owners with invalid relation", () => {
    const doc = makeDoc({
      structured_owners: [
        { person_label: "Alice", provider_account_id: "acc-1", relation: "INVALID_REL" as any },
      ],
    });
    const { nodes, edges } = buildStructuredOwnerGraph(doc);
    expect(nodes.filter((n) => n.entity_type === "person")).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("skips owners with empty person_label", () => {
    const doc = makeDoc({
      structured_owners: [
        { person_label: "", provider_account_id: "acc-1", relation: "OWNS" },
      ],
    });
    const { nodes, edges } = buildStructuredOwnerGraph(doc);
    expect(nodes.filter((n) => n.entity_type === "person")).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("uses pull_request entity_type when resource_type is pull_request", () => {
    const doc = makeDoc({
      resource_type: "pull_request",
      structured_owners: [
        { person_label: "Carol", provider_account_id: "acc-3", relation: "OWNS" },
      ],
    });
    const { nodes, edges } = buildStructuredOwnerGraph(doc);

    const workItem = nodes.find((n) => n.entity_type === "pull_request");
    expect(workItem).toBeDefined();
    expect(edges[0].target_entity_type).toBe("pull_request");
  });

  it("visibility split: person nodes org_wide, item node + owner edges inherit doc visibility", () => {
    // Playbook item 5: "ownership is org-readable only via item" — owner edges
    // carry the document's scope; person nodes stay org_wide for cross-dept dedup.
    const doc = makeDoc({
      structured_owners: [
        { person_label: "Alice", provider_account_id: "acc-1", relation: "OWNS" },
      ],
    });
    const { nodes, edges } = buildStructuredOwnerGraph(doc);
    const personNodes = nodes.filter((n) => n.entity_type === "person");
    const itemNodes = nodes.filter((n) => n.entity_type !== "person");
    personNodes.forEach((n) => expect(n.visibility).toBe("org_wide"));
    itemNodes.forEach((n) => expect(n.visibility).toBe("department"));
    edges.forEach((e) => expect(e.visibility).toBe("department"));
  });

  it("sets org_id and department_id on all nodes and edges", () => {
    const doc = makeDoc({
      structured_owners: [
        { person_label: "Alice", provider_account_id: "acc-1", relation: "OWNS" },
      ],
    });
    const { nodes, edges } = buildStructuredOwnerGraph(doc);

    nodes.forEach((n) => expect(n.org_id).toBe("org-1"));
    edges.forEach((e) => expect(e.org_id).toBe("org-1"));
    edges.forEach((e) => expect(e.department_id).toBe("dept-1"));
  });
});
