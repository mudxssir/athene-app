"use client";

// FIX #3: Removed unused ExternalLink import
import { X, FileText, GitBranch } from "lucide-react";
import { ENTITY_COLORS, type EntityColorKey } from "@/components/graph/knowledge-graph-canvas";

interface NodeData {
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

interface NeighborInfo {
  id: string;
  label: string;
  entity_type: string;
  relation: string;
  direction: "outbound" | "inbound";
}

interface NodeDetailPanelProps {
  node: NodeData | null;
  neighbors: NeighborInfo[];
  isLoading: boolean;
  onClose: () => void;
  onNavigateToNode: (nodeId: string) => void;
}

export function NodeDetailPanel({
  node,
  neighbors,
  isLoading,
  onClose,
  onNavigateToNode,
}: NodeDetailPanelProps) {
  if (!node) return null;

  const colorKey = node.entity_type as EntityColorKey;
  const color = ENTITY_COLORS[colorKey] ?? ENTITY_COLORS.concept;

  return (
    <div className="node-detail-panel" id="node-detail-panel">
      {/* Header */}
      <div className="node-detail-panel__header">
        <div className="node-detail-panel__title-row">
          <div
            className="node-detail-panel__badge"
            style={{ backgroundColor: color, color: "#fff" }}
          >
            {node.entity_type}
          </div>
          <button
            onClick={onClose}
            className="node-detail-panel__close"
            aria-label="Close panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <h3 className="node-detail-panel__label">{node.label}</h3>
      </div>

      {/* FIX #6: Body with scroll to prevent viewport overflow */}
      <div
        className="node-detail-panel__body"
        style={{ overflowY: "auto", maxHeight: "calc(100vh - 120px)" }}
      >
        {/* Description */}
        {node.description && (
          <div className="node-detail-panel__section">
            <h4 className="node-detail-panel__section-title">Description</h4>
            <p className="node-detail-panel__description">{node.description}</p>
          </div>
        )}

        {/* Metadata */}
        <div className="node-detail-panel__section">
          <h4 className="node-detail-panel__section-title">Details</h4>
          <div className="node-detail-panel__meta-grid">
            <div className="node-detail-panel__meta-item">
              <span className="node-detail-panel__meta-label">Visibility</span>
              <span className="node-detail-panel__meta-value">
                {node.visibility ?? "—"}
              </span>
            </div>
            {node.community && (
              <div className="node-detail-panel__meta-item">
                <span className="node-detail-panel__meta-label">Community</span>
                <span className="node-detail-panel__meta-value">
                  {node.community}
                </span>
              </div>
            )}
            {node.updated_at && (
              <div className="node-detail-panel__meta-item">
                <span className="node-detail-panel__meta-label">Updated</span>
                <span className="node-detail-panel__meta-value">
                  {/* FIX #4: Guard against malformed dates */}
                  {(() => {
                    const d = new Date(node.updated_at!);
                    return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
                  })()}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Source Documents */}
        {node.source_documents && node.source_documents.length > 0 && (
          <div className="node-detail-panel__section">
            <h4 className="node-detail-panel__section-title">
              <FileText className="h-3.5 w-3.5 inline mr-1.5" />
              Source Documents ({node.source_documents.length})
            </h4>
            <ul className="node-detail-panel__doc-list">
              {node.source_documents.slice(0, 10).map((docId) => (
                <li key={docId} className="node-detail-panel__doc-item">
                  <a
                    href={`/api/files/download?id=${docId}`}
                    download
                    className="node-detail-panel__doc-id hover:underline flex items-center gap-1"
                    title={`Download document ${docId}`}
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    {docId.slice(0, 8)}…
                  </a>
                </li>
              ))}
            </ul>
            {/* FIX #2: Indicate when more documents exist beyond visible 10 */}
            {node.source_documents.length > 10 && (
              <p className="node-detail-panel__doc-overflow">
                +{node.source_documents.length - 10} more
              </p>
            )}
          </div>
        )}

        {/* Neighbors */}
        <div className="node-detail-panel__section">
          <h4 className="node-detail-panel__section-title">
            <GitBranch className="h-3.5 w-3.5 inline mr-1.5" />
            Connections ({neighbors.length})
          </h4>
          {isLoading ? (
            <div className="node-detail-panel__loading">Loading neighbors…</div>
          ) : neighbors.length === 0 ? (
            <p className="node-detail-panel__empty">No connections found</p>
          ) : (
            <ul className="node-detail-panel__neighbor-list">
              {neighbors.map((n) => {
                const nColor =
                  ENTITY_COLORS[n.entity_type as EntityColorKey] ??
                  ENTITY_COLORS.concept;
                return (
                  // FIX #1: Use n.id as stable key (no index)
                  <li key={n.id} className="node-detail-panel__neighbor">
                    <button
                      onClick={() => onNavigateToNode(n.id)}
                      className="node-detail-panel__neighbor-btn"
                    >
                      <span
                        className="node-detail-panel__neighbor-dot"
                        style={{ backgroundColor: nColor }}
                      />
                      <span className="node-detail-panel__neighbor-label">
                        {n.label}
                      </span>
                      <span className="node-detail-panel__neighbor-rel">
                        {/* FIX #5: Strip underscores from relation for display */}
                        {n.direction === "outbound" ? "→" : "←"}{" "}
                        {n.relation.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
