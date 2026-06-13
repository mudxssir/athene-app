"use client";

import React, { useCallback, useEffect, useState, useRef, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import { GraphSearch } from "./graph-search";
import { NodeDetailPanel } from "./node-detail-panel";
import { Loader2, Network, RefreshCw, Filter } from "lucide-react";

// ── Entity colour map ───────────────────────────────────────
export const ENTITY_COLORS: Record<string, string> = {
  service:      "#A04A1B",  // sienna-500   — brand primary
  person:       "#4F7A2E",  // olive-green   — universal person signal
  project:      "#D97A2E",  // amber-500    — supporting orange
  concept:      "#E6B928",  // honey-400    — yellow-gold
  team:         "#6B2E0E",  // sienna-700   — dark earth
  technology:   "#BF7038",  // sienna-400   — mid orange-brown
  process:      "#8B6D45",  // coffee-300   — tan
  organization: "#5A4225",  // coffee-500   — darker tan
  product:      "#B23A1A",  // danger       — warm red-orange
};
export type EntityColorKey = keyof typeof ENTITY_COLORS;

/**
 * Deterministic colour fallback for entity types not in ENTITY_COLORS
 * (e.g. "deal", "incident", "contract" from the extended type registry).
 * Uses a palette of brand-adjacent hues keyed by a simple string hash.
 */
function entityColorFallback(entityType: string): string {
  const hash = entityType.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const palette = ["#7c3aed", "#0d9488", "#b45309", "#dc2626", "#2563eb", "#9333ea"];
  return palette[hash % palette.length];
}

/** Resolve a node colour — ENTITY_COLORS first, then hashed fallback */
function resolveNodeColor(entityType: string): string {
  return ENTITY_COLORS[entityType] ?? entityColorFallback(entityType);
}

// ── Types ───────────────────────────────────────────────────

/** Shape of a node coming from the API */
interface APINode {
  id: string;
  label: string;
  entity_type: string;
  description?: string | null;
  department_ids?: string[];
  source_documents?: string[];
  visibility?: string;
  community?: number | null;
  updated_at?: string;
}

/** Shape of an edge coming from the API */
interface APIEdge {
  id: string;
  source_node: string;
  target_node: string;
  relation: string;
  provenance: string;
  confidence: number;
}

interface NeighborInfo {
  id: string;
  label: string;
  entity_type: string;
  relation: string;
  direction: "outbound" | "inbound";
}

interface KnowledgeGraphCanvasProps {
  userRole: string;
  focusNodeId?: string;
}

// ── React Flow node data shape ──────────────────────────────
type GraphNodeData = Record<string, unknown> & {
  label: string;
  entity_type: string;
};

type GraphNode = Node<GraphNodeData>;

// We store the edge's relation text in data.relation so we can
// access it type-safely (Edge.label is ReactNode, not string).
type GraphEdgeData = Record<string, unknown> & {
  relation: string;
};

type GraphEdge = Edge<GraphEdgeData>;


// ── Deterministic jitter (FIX #2: replaces Math.random) ─────
/** Hash-based jitter so node positions are stable across re-renders */
function jitter(id: string, scale: number): number {
  const hash = id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return ((hash % 100) / 100 - 0.5) * scale;
}

// ── Force-directed layout (vis-network-style physics) ───────
//
// Communities gravitate into organic clusters and cross-community
// edges stretch visibly between them — the layout EMERGES from the
// topology instead of a rigid grid:
//   · forceLink     — connected nodes pull together (spring)
//   · forceManyBody — all nodes repel (charge), spreading clusters
//   · community gravity — each node is gently pulled toward its
//     community's anchor on a ring, so sparse communities still
//     separate into distinct visual groups
//   · forceCollide  — no overlapping dots
// The simulation runs synchronously to convergence (deterministic:
// seeded by hash jitter, no Math.random), then positions are frozen
// into React Flow nodes — pan/zoom/drag stay fully interactive.

interface SimNode extends SimulationNodeDatum {
  id: string;
  community: number | string;
  degree: number;
}

/** Degree-scaled dot radius (vis-network sizes hubs larger). */
function nodeRadius(degree: number): number {
  return Math.min(30, 11 + Math.sqrt(degree) * 3.5);
}

function forceLayout(apiNodes: APINode[], apiEdges: APIEdge[]): GraphNode[] {
  const idSet = new Set(apiNodes.map((n) => n.id));
  const degree = new Map<string, number>();
  apiEdges.forEach((e) => {
    if (idSet.has(e.source_node)) degree.set(e.source_node, (degree.get(e.source_node) ?? 0) + 1);
    if (idSet.has(e.target_node)) degree.set(e.target_node, (degree.get(e.target_node) ?? 0) + 1);
  });

  // Community anchors on a ring — radius grows with community count so
  // clusters have room. Unassigned nodes share a center anchor.
  const communityKeys = Array.from(
    new Set(apiNodes.map((n) => n.community ?? "__none__"))
  );
  const ringR = Math.max(380, communityKeys.length * 130);
  const anchors = new Map<number | string, { x: number; y: number }>();
  communityKeys.forEach((key, i) => {
    const ang = (i / Math.max(communityKeys.length, 1)) * 2 * Math.PI;
    anchors.set(key, { x: Math.cos(ang) * ringR, y: Math.sin(ang) * ringR });
  });

  const simNodes: SimNode[] = apiNodes.map((n) => {
    const key = n.community ?? "__none__";
    const anchor = anchors.get(key)!;
    return {
      id: n.id,
      community: key,
      degree: degree.get(n.id) ?? 0,
      // Seed near the community anchor with deterministic jitter
      x: anchor.x + jitter(n.id, 240),
      y: anchor.y + jitter(n.id + "y", 240),
    };
  });

  const simLinks = apiEdges
    .filter((e) => idSet.has(e.source_node) && idSet.has(e.target_node))
    .map((e) => ({ source: e.source_node, target: e.target_node }));

  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, { source: string; target: string }>(simLinks)
        .id((d) => d.id)
        .distance(95)
        .strength(0.5)
    )
    .force("charge", forceManyBody<SimNode>().strength(-220))
    .force("collide", forceCollide<SimNode>((d) => nodeRadius(d.degree) + 14))
    .force("cx", forceX<SimNode>((d) => anchors.get(d.community)!.x).strength(0.07))
    .force("cy", forceY<SimNode>((d) => anchors.get(d.community)!.y).strength(0.07))
    .stop();

  // Synchronous convergence (vis-network "stabilization")
  const ticks = Math.min(320, Math.max(160, simNodes.length));
  for (let i = 0; i < ticks; i++) sim.tick();

  const posById = new Map(simNodes.map((s) => [s.id, { x: s.x ?? 0, y: s.y ?? 0 }]));

  return apiNodes.map((n) => {
    const pos = posById.get(n.id)!;
    const deg = degree.get(n.id) ?? 0;
    return {
      id: n.id,
      type: "dot",
      position: { x: pos.x, y: pos.y },
      data: {
        label: n.label,
        entity_type: n.entity_type,
        degree: deg,
        description: n.description ?? null,
        department_ids: n.department_ids ?? [],
        source_documents: n.source_documents ?? [],
        visibility: n.visibility ?? "public",
        community: n.community ?? null,
        updated_at: n.updated_at ?? null,
      },
    };
  });
}

// ── Dot node (vis-network look: colored circle, label beneath) ─
function DotNode({ data, selected }: { data: GraphNodeData; selected?: boolean }) {
  const color = resolveNodeColor(data.entity_type);
  const r = nodeRadius((data.degree as number) ?? 0);
  const dimmed = data.__dimmed === true;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 5,
        opacity: dimmed ? 0.12 : 1,
        transition: "opacity .2s ease",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          position: "relative",
          width: r * 2,
          height: r * 2,
          borderRadius: "50%",
          background: color,
          border: "2px solid color-mix(in oklab, #fff 35%, transparent)",
          boxShadow: selected
            ? `0 0 0 4px var(--accent-lav-border), 0 4px 16px ${color}66`
            : `0 2px 10px ${color}55`,
          transition: "box-shadow .2s ease",
        }}
      >
        {/* Invisible centered handles — edges attach to the dot itself */}
        <Handle type="target" position={Position.Top} style={{ opacity: 0, top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none" }} />
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0, top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 1, height: 1, minWidth: 0, minHeight: 0, border: "none" }} />
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          maxWidth: 130,
          textAlign: "center",
          lineHeight: 1.25,
          color: "var(--fg)",
          textShadow: "0 1px 3px var(--bg), 0 0 6px var(--bg)",
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {data.label}
      </span>
    </div>
  );
}

const NODE_TYPES = { dot: DotNode };

// vis-network style: thin quiet edges, NO persistent labels (relation text
// appears only on the edges of the selected node — hundreds of always-on
// labels were most of the old visual noise).
function buildEdges(apiEdges: APIEdge[]): GraphEdge[] {
  return apiEdges.map((e): GraphEdge => {
    const dashed = e.provenance === "INFERRED" || e.provenance === "AMBIGUOUS";
    return {
      id: e.id,
      source: e.source_node,
      target: e.target_node,
      type: "default",
      style: {
        stroke: "var(--border-strong)",
        strokeWidth: 1.2,
        ...(dashed ? { strokeDasharray: e.provenance === "INFERRED" ? "6,3" : "2,2" } : {}),
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: "var(--border-strong)" },
      data: { relation: e.relation, provenance: e.provenance },
    };
  });
}

// ── Edge fetch helper (FIX #4: chunks to avoid URL length limits) ──
const EDGE_BATCH_SIZE = 100;

async function fetchEdgesInBatches(nodeIds: string[]): Promise<APIEdge[]> {
  const allEdges: APIEdge[] = [];

  for (let i = 0; i < nodeIds.length; i += EDGE_BATCH_SIZE) {
    const batch = nodeIds.slice(i, i + EDGE_BATCH_SIZE);
    const params = batch.map((id) => `nodeIds[]=${id}`).join("&");
    try {
      const res = await fetch(`/api/graph/edges?${params}`);
      if (res.ok) {
        const data = await res.json();
        allEdges.push(...(data.edges ?? []));
      }
    } catch (err) {
      console.error("[graph] Edge batch fetch error:", err);
    }
  }

  // Deduplicate by edge ID
  const seen = new Set<string>();
  return allEdges.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

// ── Main Component ──────────────────────────────────────────

// ── Internal Component for Provider ─────────────────────────
function KnowledgeGraphCanvasInternal({ userRole, focusNodeId }: KnowledgeGraphCanvasProps) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);
  const [apiNodes, setApiNodes] = useState<APINode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isEmpty, setIsEmpty] = useState(false);
  const [selectedNode, setSelectedNode] = useState<APINode | null>(null);
  const [neighbors, setNeighbors] = useState<NeighborInfo[]>([]);
  const [neighborsLoading, setNeighborsLoading] = useState(false);
  // FIX #7: highlightedIds removed — was set but never read
  const [communities, setCommunities] = useState<number[]>([]);
  const [loadedCommunities, setLoadedCommunities] = useState<Set<number>>(new Set());
  const [totalNodes, setTotalNodes] = useState(0);
  const [isBuildingGraph, setIsBuildingGraph] = useState(false);
  const [departmentFilter, setDepartmentFilter] = useState("");
  const initRef = useRef(false);
  const buildPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // FIX #1: Use ref for apiNodes to break the stale closure cycle
  const apiNodesRef = useRef<APINode[]>([]);
  useEffect(() => {
    apiNodesRef.current = apiNodes;
  }, [apiNodes]);

  // ── Fetch nodes (FIX #1: reads apiNodesRef.current, not apiNodes) ──
  const fetchNodes = useCallback(
    async (page = 1, community?: number, append = false) => {
      setIsLoading(true);
      try {
        let url = `/api/graph/nodes?page=${page}&limit=200`;
        if (community) url += `&community=${encodeURIComponent(community)}`;
        if (departmentFilter) url += `&departmentId=${encodeURIComponent(departmentFilter)}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch nodes");
        const data = await res.json();

        const newNodes: APINode[] = data.nodes ?? [];
        setTotalNodes(data.total ?? 0);
        setCommunities(data.communities ?? []);

        if (newNodes.length === 0 && !append) {
          setIsEmpty(true);
          setApiNodes([]);
          setNodes([]);
          setEdges([]);
          return;
        }

        setIsEmpty(false);
        const currentApiNodes = apiNodesRef.current;
        const mergedNodes = append
          ? [...currentApiNodes, ...newNodes.filter((n) => !currentApiNodes.some((e) => e.id === n.id))]
          : newNodes;

        // Seed loadedCommunities with the communities present in the initial load
        // so "Load more communities" only appears when there are truly unloaded ones.
        if (!append) {
          const represented = new Set(
            newNodes
              .filter((n) => n.community !== null && n.community !== undefined)
              .map((n) => n.community as number)
          );
          setLoadedCommunities(represented);
        }

        setApiNodes(mergedNodes);

        // Edges FIRST, then layout: the force simulation needs the link
        // topology to pull communities into organic clusters.
        const nodeIds = mergedNodes.map((n) => n.id);
        const allEdges = nodeIds.length > 0 ? await fetchEdgesInBatches(nodeIds) : [];
        setNodes(forceLayout(mergedNodes, allEdges));
        setEdges(buildEdges(allEdges));
      } catch (err) {
        console.error("[graph] Fetch error:", err);
      } finally {
        setIsLoading(false);
      }
    },
    [departmentFilter, setNodes, setEdges] // FIX #1: apiNodes removed from deps
  );

  // ── Initial load ──────────────────────────────────────────
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    fetchNodes(1);
  }, [fetchNodes]);

  // Clean up build-graph polling interval on unmount
  useEffect(() => {
    return () => {
      if (buildPollRef.current) clearInterval(buildPollRef.current);
    };
  }, []);

  // Department filter change triggers re-fetch.
  // Only fires when the value is empty or a structurally valid UUID —
  // prevents spammy requests while the admin is still typing.
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  useEffect(() => {
    if (!initRef.current) return;
    if (departmentFilter && !UUID_REGEX.test(departmentFilter)) return;
    fetchNodes(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentFilter]);

  // FIX #8: Focus mode logic
  useEffect(() => {
    if (!isLoading && focusNodeId && nodes.length > 0) {
      const node = nodes.find((n) => n.id === focusNodeId);
      if (node) {
        // We use a small timeout to ensure the canvas has rendered the nodes
        setTimeout(() => {
          fitView({ nodes: [node], duration: 1000, padding: 2 });
          setSelectedNode(apiNodesRef.current.find((n) => n.id === focusNodeId) || null);
        }, 500);
      }
    }
  }, [isLoading, focusNodeId, nodes, fitView]);

  // ── Pre-built adjacency map — O(1) neighbor lookup per node ─
  // Rebuilt only when edges or apiNodes change, not on every click.
  const adjacencyMap = useMemo(() => {
    const nodeIndex = new Map(apiNodes.map((n) => [n.id, n]));
    const map = new Map<string, NeighborInfo[]>();

    edges.forEach((e) => {
      const relation = (e.data as GraphEdgeData | undefined)?.relation ?? "RELATED_TO";
      if (!map.has(e.source)) map.set(e.source, []);
      if (!map.has(e.target)) map.set(e.target, []);

      const targetNode = nodeIndex.get(e.target);
      const sourceNode = nodeIndex.get(e.source);

      if (targetNode) {
        map.get(e.source)!.push({
          id: targetNode.id,
          label: targetNode.label,
          entity_type: targetNode.entity_type,
          relation,
          direction: "outbound",
        });
      }
      if (sourceNode) {
        map.get(e.target)!.push({
          id: sourceNode.id,
          label: sourceNode.label,
          entity_type: sourceNode.entity_type,
          relation,
          direction: "inbound",
        });
      }
    });

    return map;
  }, [edges, apiNodes]);

  // ── Node click → neighborhood highlight + side panel ──────
  // vis-network behavior: clicking a node dims everything outside its
  // 1-hop neighborhood; connected edges light up in the node's color and
  // show their relation labels.
  const applyNeighborhoodHighlight = useCallback(
    (nodeId: string | null) => {
      if (nodeId === null) {
        setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, __dimmed: false } })));
        setEdges((prev) =>
          prev.map((e) => ({
            ...e,
            label: undefined,
            animated: false,
            style: { ...e.style, stroke: "var(--border-strong)", strokeWidth: 1.2, opacity: 1 },
            markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: "var(--border-strong)" },
          }))
        );
        return;
      }

      const hood = new Set<string>([nodeId]);
      (adjacencyMap.get(nodeId) ?? []).forEach((nb) => hood.add(nb.id));
      const focusColor = resolveNodeColor(
        apiNodesRef.current.find((n) => n.id === nodeId)?.entity_type ?? "concept"
      );

      setNodes((prev) =>
        prev.map((n) => ({ ...n, data: { ...n.data, __dimmed: !hood.has(n.id) } }))
      );
      setEdges((prev) =>
        prev.map((e) => {
          const connected = e.source === nodeId || e.target === nodeId;
          const relation = ((e.data as GraphEdgeData | undefined)?.relation ?? "").replace(/_/g, " ");
          return {
            ...e,
            label: connected ? relation : undefined,
            animated: connected,
            labelStyle: { fontSize: 9, fill: "var(--fg-muted)", fontWeight: 700, letterSpacing: "0.08em" },
            labelBgStyle: { fill: "var(--bg-elevated)", fillOpacity: 0.9 },
            labelBgPadding: [4, 2] as [number, number],
            labelBgBorderRadius: 4,
            style: {
              ...e.style,
              stroke: connected ? focusColor : "var(--border-strong)",
              strokeWidth: connected ? 1.8 : 1.2,
              opacity: connected ? 1 : 0.08,
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 11,
              height: 11,
              color: connected ? focusColor : "var(--border-strong)",
            },
          };
        })
      );
    },
    [adjacencyMap, setNodes, setEdges]
  );

  const handleNodeClick: NodeMouseHandler<GraphNode> = useCallback(
    (_event, rfNode) => {
      const node = apiNodesRef.current.find((n) => n.id === rfNode.id);
      if (!node) return;

      setSelectedNode(node);
      applyNeighborhoodHighlight(node.id);
      setNeighborsLoading(true);
      setNeighbors([]);

      // Defer so the loading spinner renders before we do the map lookup
      setTimeout(() => {
        setNeighbors(adjacencyMap.get(node.id) ?? []);
        setNeighborsLoading(false);
      }, 0);
    },
    [adjacencyMap, applyNeighborhoodHighlight]
  );

  // Click on empty canvas clears the highlight
  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
    applyNeighborhoodHighlight(null);
  }, [applyNeighborhoodHighlight]);

  // ── Search highlight ──────────────────────────────────────
  const handleSearchResults = useCallback(
    (nodeIds: string[]) => {
      const matchSet = new Set(nodeIds);
      setNodes((prev) =>
        prev.map((n) => ({ ...n, data: { ...n.data, __dimmed: !matchSet.has(n.id) } }))
      );
      const matchedRFNodes = nodes.filter((n) => matchSet.has(n.id));
      if (matchedRFNodes.length > 0) {
        setTimeout(() => fitView({ nodes: matchedRFNodes, padding: 0.5, duration: 600 }), 50);
      }
    },
    [setNodes, nodes, fitView]
  );

  const handleSearchClear = useCallback(() => {
    applyNeighborhoodHighlight(null);
  }, [applyNeighborhoodHighlight]);

  // ── Load more communities ─────────────────────────────────
  const handleLoadMore = useCallback(() => {
    const unloaded = communities.filter((c) => !loadedCommunities.has(c));
    if (unloaded.length === 0) return;

    const next = unloaded[0];
    setLoadedCommunities((prev) => new Set([...prev, next]));
    fetchNodes(1, next, true);
  }, [communities, loadedCommunities, fetchNodes]);

  // ── Navigate to node ──────────────────────────────────────
  const handleNavigateToNode = useCallback(
    (nodeId: string) => {
      const node = apiNodesRef.current.find((n) => n.id === nodeId);
      if (!node) return;
      setSelectedNode(node);
      // Pan the canvas to the target node so the user can see it
      const rfNode = nodes.find((n) => n.id === nodeId);
      if (rfNode) {
        setTimeout(() => fitView({ nodes: [rfNode], duration: 500, padding: 2 }), 0);
      }
    },
    [nodes, fitView]
  );

  // ── Build graph (empty state) ─────────────────────────────
  // After enqueueing, poll every 5s (max 2 min) until nodes appear.
  // The QStash worker may take 10–60+ seconds to finish — a fixed 5s
  // timeout would almost always arrive before the worker completes.
  const handleBuildGraph = useCallback(async () => {
    // Clear any existing poll interval before starting a new one — prevents
    // double-polling if the user clicks "Build" again while a poll is running.
    if (buildPollRef.current) {
      clearInterval(buildPollRef.current);
      buildPollRef.current = null;
    }
    setIsBuildingGraph(true);
    try {
      const res = await fetch("/api/graph/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_type: "full" }),
      });
      if (!res.ok) throw new Error("Build request failed");

      let attempts = 0;
      buildPollRef.current = setInterval(async () => {
        attempts++;
        try {
          const r = await fetch("/api/graph/nodes?limit=1");
          if (r.ok) {
            const d = await r.json();
            if ((d.total ?? 0) > 0) {
              clearInterval(buildPollRef.current!);
              buildPollRef.current = null;
              setIsBuildingGraph(false);
              fetchNodes(1);
              return;
            }
          }
        } catch {}
        // Stop polling after 2 minutes (24 × 5s)
        if (attempts >= 24) {
          clearInterval(buildPollRef.current!);
          buildPollRef.current = null;
          setIsBuildingGraph(false);
        }
      }, 5000);
    } catch (err) {
      console.error("[graph] Build failed:", err);
      setIsBuildingGraph(false);
    }
  }, [fetchNodes]);

  // ── MiniMap node colour ───────────────────────────────────
  const miniMapNodeColor = useCallback((node: GraphNode) => {
    const entityType = node.data?.entity_type as string | undefined;
    return entityType ? resolveNodeColor(entityType) : "#6b7280";
  }, []);

  // ── Empty state ───────────────────────────────────────────
  if (!isLoading && isEmpty) {
    return (
      <div className="graph-empty-state" id="graph-empty-state">
        <div className="graph-empty-state__icon">
          <Network className="h-16 w-16" />
        </div>
        <h3 className="graph-empty-state__title">No Knowledge Graph Yet</h3>
        <p className="graph-empty-state__desc">
          Build your organization&apos;s knowledge map from connected documents.
        </p>
        <button
          onClick={handleBuildGraph}
          disabled={isBuildingGraph}
          className="graph-empty-state__btn"
          id="build-graph-btn"
        >
          {isBuildingGraph ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Building…
            </>
          ) : (
            <>
              <Network className="h-4 w-4 mr-2" />
              Build Knowledge Graph
            </>
          )}
        </button>
      </div>
    );
  }

  // ── Loading state ─────────────────────────────────────────
  if (isLoading && apiNodes.length === 0) {
    return (
      <div className="graph-loading" id="graph-loading">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p>Loading knowledge graph…</p>
      </div>
    );
  }

  // ── Canvas ────────────────────────────────────────────────
  const hasMoreCommunities = communities.some((c) => !loadedCommunities.has(c));

  return (
    <div className="graph-canvas-wrapper" id="graph-canvas-wrapper">
      {/* Toolbar */}
      <div className="graph-toolbar" id="graph-toolbar">
        <GraphSearch
          onSearchResults={handleSearchResults}
          onClear={handleSearchClear}
        />

        {/* Department filter (admin only) */}
        {userRole === "admin" && (
          <div className="graph-toolbar__filter">
            <Filter className="h-3.5 w-3.5" />
            <input
              type="text"
              placeholder="Department ID…"
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="graph-toolbar__filter-input"
              id="dept-filter-input"
            />
          </div>
        )}

        <button
          onClick={() => fetchNodes(1)}
          className="graph-toolbar__refresh"
          aria-label="Refresh graph"
          id="refresh-graph-btn"
        >
          <RefreshCw className="h-4 w-4" />
        </button>

        <span className="graph-toolbar__count">
          {apiNodes.length} / {totalNodes} nodes
        </span>
      </div>

      {/* React Flow Canvas */}
      <div className="graph-canvas" id="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.1}
          maxZoom={3}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            type: "default",
          }}
        >
          <Background color="var(--border)" gap={24} size={1} />
          <Controls
            showInteractive={false}
            position="bottom-left"
            className="graph-controls"
          />
          <MiniMap
            nodeColor={miniMapNodeColor}
            maskColor="rgba(10, 10, 15, 0.7)"
            className="graph-minimap"
            position="bottom-right"
          />
        </ReactFlow>
      </div>

      {/* Load more */}
      {hasMoreCommunities && (
        <button
          onClick={handleLoadMore}
          className="graph-load-more"
          id="load-more-btn"
        >
          Load more communities
        </button>
      )}

      {/* Legend */}
      <div className="graph-legend" id="graph-legend">
        {Object.entries(ENTITY_COLORS).map(([type, color]) => (
          <div key={type} className="graph-legend__item">
            <span
              className="graph-legend__dot"
              style={{ backgroundColor: color }}
            />
            <span className="graph-legend__label">{type}</span>
          </div>
        ))}
      </div>

      {/* Node detail panel */}
      <NodeDetailPanel
        node={selectedNode}
        neighbors={neighbors}
        isLoading={neighborsLoading}
        onClose={() => setSelectedNode(null)}
        onNavigateToNode={handleNavigateToNode}
      />
    </div>
  );
}

// ── Main Export with Provider ───────────────────────────────
export function KnowledgeGraphCanvas(props: KnowledgeGraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <KnowledgeGraphCanvasInternal {...props} />
    </ReactFlowProvider>
  );
}
