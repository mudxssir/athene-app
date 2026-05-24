"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Network, Search, Loader2 } from "lucide-react";
import { ENTITY_COLORS, type EntityColorKey } from "@/components/graph/knowledge-graph-canvas";
import { useSearchParams } from "next/navigation";
import { TCard } from "@/components/ui/kit";

// Lazy-load the canvas to avoid SSR issues with React Flow
const KnowledgeGraphCanvas = dynamic(
  () =>
    import("@/components/graph/knowledge-graph-canvas").then(
      (mod) => mod.KnowledgeGraphCanvas
    ),
  {
    ssr: false,
    loading: () => (
      <div className="graph-loading" id="graph-loading-ssr">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p>Loading graph canvas…</p>
      </div>
    ),
  }
);

// ── Mobile list view ────────────────────────────────────────
interface MobileNode {
  id: string;
  label: string;
  entity_type: string;
  description?: string | null;
  community?: string;
}

function MobileGraphList() {
  const [nodes, setNodes] = useState<MobileNode[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    // Reset to page 1 on search change
    setPage(1);
  }, [search]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const url = `/api/graph/nodes?limit=50&page=${page}${
          search ? `&search=${encodeURIComponent(search)}` : ""
        }`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!active) return;
        setFetchError(null);
        if (page === 1) {
          setNodes(data.nodes ?? []);
        } else {
          setNodes((prev) => [...prev, ...(data.nodes ?? [])]);
        }
        setTotal(data.total ?? 0);
      } catch (err) {
        console.error("[MobileGraphList] Failed to fetch nodes:", err);
        if (!active) return;
        setFetchError("Failed to load nodes. Tap to retry.");
        if (page === 1) {
          setNodes([]);
          setTotal(0);
        }
      } finally {
        if (active) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    }

    if (page === 1) {
      const t = setTimeout(() => {
        setIsLoading(true);
        load();
      }, 300);
      return () => {
        active = false;
        clearTimeout(t);
      };
    } else {
      setIsLoadingMore(true);
      load();
      return () => {
        active = false;
      };
    }
  }, [search, page]);

  return (
    <div className="graph-mobile" id="graph-mobile-view">
      <div className="graph-mobile__search">
        <Search className="h-4 w-4" />
        <input
          type="text"
          placeholder="Search nodes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="graph-mobile__search-input"
          id="mobile-graph-search"
        />
      </div>

      {!isLoading && nodes.length > 0 && (
        <div className="flex justify-between items-center mb-4 px-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">
            Showing {nodes.length} of {total} nodes
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="graph-mobile__loading">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : fetchError ? (
        <div className="graph-mobile__empty">
          <Network className="h-10 w-10 opacity-30" />
          <p className="text-sm text-destructive mb-3">{fetchError}</p>
          <button
            onClick={() => { setFetchError(null); setPage(1); }}
            className="text-xs font-black uppercase tracking-widest text-purple-400 hover:text-purple-300"
          >
            Retry
          </button>
        </div>
      ) : nodes.length === 0 ? (
        <div className="graph-mobile__empty">
          <Network className="h-10 w-10 opacity-30" />
          <p>No nodes found</p>
        </div>
      ) : (
        <>
          <ul className="graph-mobile__list">
            {nodes.map((n) => (
              <li key={n.id} className="graph-mobile__item">
                <div
                  className="graph-mobile__item-dot"
                  style={{
                    backgroundColor:
                      ENTITY_COLORS[n.entity_type as EntityColorKey] ??
                      ENTITY_COLORS.concept,
                  }}
                />
                <div className="graph-mobile__item-content">
                  <span className="graph-mobile__item-label">{n.label}</span>
                  <span className="graph-mobile__item-type">{n.entity_type}</span>
                  {n.description && (
                    <p className="graph-mobile__item-desc">
                      {n.description.slice(0, 120)}
                      {n.description.length > 120 ? "…" : ""}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {nodes.length < total && (
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={isLoadingMore}
              className="mt-6 w-full h-14 rounded-2xl border border-white/5 bg-card hover:bg-white/5 active:scale-[0.98] transition-all flex items-center justify-center gap-2 text-xs font-black uppercase tracking-widest text-purple-400 disabled:opacity-50"
            >
              {isLoadingMore ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading nodes...
                </>
              ) : (
                "Load More Nodes"
              )}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Page Component ──────────────────────────────────────────
export default function GraphPage() {
  const searchParams = useSearchParams();
  // FIX #1: null initial state prevents SSR flicker
  const [isMobile, setIsMobile] = useState<boolean | null>(null);
  const [userRole, setUserRole] = useState("member");

  // Detect mobile breakpoint
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 768px)");
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener?.("change", handler);
    return () => mql.removeEventListener?.("change", handler);
  }, []);

  // Fetch role only on desktop (used by the department filter in the canvas)
  useEffect(() => {
    if (isMobile !== false) return;
    fetch("/api/user/role")
      .then((r) => r.json())
      .then((d) => {
        if (d.role && typeof d.role === "string") setUserRole(d.role);
      })
      .catch(() => {});
  }, [isMobile]);

  return (
    <div id="graph-page">
      {/* Page Header */}
      <TCard i={0} className="graph-page__header">
        <div>
          <h1 className="graph-page__title">
            <Network className="h-7 w-7 inline-block mr-2 text-primary" />
            Knowledge Graph
          </h1>
          <p className="graph-page__subtitle">
            Interactive map of your organization&apos;s connected knowledge
          </p>
        </div>
      </TCard>

      {/* FIX #1: Render nothing until isMobile is resolved */}
      <TCard i={1}>
        {isMobile === null ? null : isMobile ? (
          <MobileGraphList />
        ) : (
          <KnowledgeGraphCanvas userRole={userRole} focusNodeId={searchParams.get("focus") || undefined} />
        )}
      </TCard>
    </div>
  );
}
