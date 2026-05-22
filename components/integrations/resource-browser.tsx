"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Folder,
  File,
  Hash,
  GitBranch,
  Database,
  FileText,
  Layers,
  FolderKanban,
  Box,
  ChevronRight,
  ChevronDown,
  Check,
  Minus,
  Loader2,
  Settings2,
  X,
  Search,
  Save,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SelectedResource } from "@/lib/integrations/sync-config";

// ---- Types --------------------------------------------------

interface BrowsableResource {
  id: string;
  name: string;
  type: "folder" | "file" | "channel" | "repo" | "database" | "page" | "space" | "project" | "object_type";
  hasChildren: boolean;
  path: string;
  metadata?: Record<string, unknown>;
}

interface ResourceBrowserProps {
  connectionId: string;
  provider: string;
  providerName: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

// ---- Icon map -----------------------------------------------

function ResourceIcon({ type, className }: { type: string; className?: string }) {
  const iconClass = cn("w-4 h-4", className);
  switch (type) {
    case "folder":
      return <Folder className={cn(iconClass, "text-amber-400")} />;
    case "file":
      return <File className={cn(iconClass, "text-blue-400")} />;
    case "channel":
      return <Hash className={cn(iconClass, "text-emerald-400")} />;
    case "repo":
      return <GitBranch className={cn(iconClass, "text-primary")} />;
    case "database":
      return <Database className={cn(iconClass, "text-cyan-400")} />;
    case "page":
      return <FileText className={cn(iconClass, "text-orange-400")} />;
    case "space":
      return <Layers className={cn(iconClass, "text-violet-400")} />;
    case "project":
      return <FolderKanban className={cn(iconClass, "text-indigo-400")} />;
    case "object_type":
      return <Box className={cn(iconClass, "text-teal-400")} />;
    default:
      return <File className={cn(iconClass, "text-muted-foreground")} />;
  }
}

// ---- Main component -----------------------------------------

export function ResourceBrowser({
  connectionId,
  provider,
  providerName,
  open,
  onClose,
  onSaved,
}: ResourceBrowserProps) {
  const [resources, setResources] = useState<BrowsableResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, BrowsableResource>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, BrowsableResource[]>>(new Map());
  const [childrenLoading, setChildrenLoading] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<"all" | "selected">("all");
  const [browsable, setBrowsable] = useState(true);

  // Load root resources and existing config
  const loadResources = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Load existing sync config
      const configRes = await fetch(`/api/connections/${connectionId}/sync-config`);
      if (configRes.ok) {
        const { syncConfig } = await configRes.json();
        setMode(syncConfig?.mode ?? "all");
        if (syncConfig?.selectedResources) {
          const map = new Map<string, BrowsableResource>();
          for (const r of syncConfig.selectedResources) {
            map.set(r.id, {
              id: r.id,
              name: r.name,
              type: r.type,
              hasChildren: r.includeChildren,
              path: "",
            });
          }
          setSelected(map);
        }
      }

      // Load browsable resources
      const browseRes = await fetch(`/api/connections/${connectionId}/browse`);
      if (!browseRes.ok) throw new Error(`HTTP ${browseRes.status}`);

      const data = await browseRes.json();
      setBrowsable(data.browsable !== false);
      setResources(data.resources ?? []);
    } catch (err: any) {
      setError(err.message ?? "Failed to load resources");
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (open) {
      loadResources();
    }
  }, [open, loadResources]);

  // Load children for a folder.
  // Accepts the full parent resource so we can forward its path to the API
  // for accurate breadcrumb construction on child nodes.
  const loadChildren = useCallback(
    async (parent: BrowsableResource) => {
      const parentId = parent.id;

      // Skip if already loaded or currently loading
      setChildrenMap((prev) => {
        if (prev.has(parentId)) return prev;
        return prev; // not yet loaded — proceed below
      });

      setChildrenLoading((prev) => {
        if (prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.add(parentId);
        return next;
      });

      try {
        const qs = new URLSearchParams({ parentId });
        if (parent.path) qs.set("parentPath", parent.path);
        const res = await fetch(`/api/connections/${connectionId}/browse?${qs}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setChildrenMap((prev) => {
          if (prev.has(parentId)) return prev; // guard double-fetch
          return new Map(prev).set(parentId, data.resources ?? []);
        });
      } catch (err) {
        console.error("Failed to load children:", err);
      } finally {
        setChildrenLoading((prev) => {
          const next = new Set(prev);
          next.delete(parentId);
          return next;
        });
      }
    },
    [connectionId]  // childrenMap removed — reads via functional setState
  );

  // Toggle expand/collapse — passes the full resource so loadChildren can forward its path
  const toggleExpanded = useCallback(
    (resource: BrowsableResource) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(resource.id)) {
          next.delete(resource.id);
        } else {
          next.add(resource.id);
          if (resource.hasChildren) loadChildren(resource);
        }
        return next;
      });
    },
    [loadChildren]
  );

  // Toggle selection
  const toggleSelected = useCallback((resource: BrowsableResource) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(resource.id)) {
        next.delete(resource.id);
      } else {
        next.set(resource.id, resource);
      }
      return next;
    });
    // Automatically switch to "selected" mode when user starts picking
    setMode("selected");
  }, []);

  // Select all / deselect all
  const selectAll = useCallback(() => {
    const map = new Map<string, BrowsableResource>();
    for (const r of resources) map.set(r.id, r);
    setSelected(map);
    setMode("selected");
  }, [resources]);

  const deselectAll = useCallback(() => {
    setSelected(new Map());
    setMode("all");
  }, []);

  // Save configuration
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const selectedResources: SelectedResource[] = Array.from(selected.values()).map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type as SelectedResource["type"],
        includeChildren: r.hasChildren,
      }));

      const syncConfig =
        mode === "all"
          ? { mode: "all" as const }
          : { mode: "selected" as const, selectedResources };

      const res = await fetch(`/api/connections/${connectionId}/sync-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ syncConfig, triggerSync: true }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message ?? "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  }, [mode, selected, connectionId, onSaved, onClose]);

  // Filter resources by search
  const filteredResources = resources.filter((r) =>
    r.name.toLowerCase().includes(search.toLowerCase())
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
      <div className="bg-card border border-white/10 shadow-2xl max-w-2xl w-full mx-4 rounded-[2rem] animate-in zoom-in-95 duration-300 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between p-8 pb-4 border-b border-white/5">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-secondary/10 flex items-center justify-center border border-secondary/20">
              <Settings2 className="w-6 h-6 text-secondary" />
            </div>
            <div>
              <h3 className="text-xl font-black text-foreground tracking-tight">
                Configure Sync
              </h3>
              <p className="text-[11px] font-bold text-muted-foreground/40 uppercase tracking-widest mt-0.5">
                {providerName} · Selective Traversal
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="rounded-full hover:bg-white/5"
          >
            <X className="w-5 h-5 text-muted-foreground" />
          </Button>
        </div>

        {/* Mode toggle */}
        <div className="flex items-center gap-3 px-8 py-4 border-b border-white/5">
          <button
            onClick={() => { setMode("all"); setSelected(new Map()); }}
            className={cn(
              "px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all",
              mode === "all"
                ? "bg-secondary/10 text-secondary border border-secondary/20"
                : "text-muted-foreground hover:bg-white/5"
            )}
          >
            Sync All
          </button>
          <button
            onClick={() => setMode("selected")}
            className={cn(
              "px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all",
              mode === "selected"
                ? "bg-primary/10 text-primary border border-primary/20"
                : "text-muted-foreground hover:bg-white/5"
            )}
          >
            Select Resources
          </button>
          {mode === "selected" && (
            <Badge className="ml-auto bg-primary/10 text-primary border-none text-[9px] font-bold h-5 px-2">
              {selected.size} selected
            </Badge>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-8 py-4 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="ml-3 text-sm font-bold text-muted-foreground">
                Loading resources…
              </span>
            </div>
          ) : error ? (
            <div className="text-center py-16">
              <p className="text-sm font-bold text-destructive mb-4">{error}</p>
              <Button
                variant="outline"
                onClick={loadResources}
                className="rounded-xl border-border"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                Retry
              </Button>
            </div>
          ) : !browsable ? (
            <div className="text-center py-16">
              <p className="text-sm font-bold text-muted-foreground">
                {providerName} does not support selective resource browsing.
              </p>
              <p className="text-xs text-muted-foreground/60 mt-2">
                All available resources will be synced automatically.
              </p>
            </div>
          ) : (
            <>
              {/* Search */}
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search resources..."
                  className="w-full h-10 pl-10 pr-4 bg-white/5 border border-white/5 rounded-xl text-sm font-medium placeholder:text-muted-foreground/40 text-foreground outline-none focus:border-secondary/30 transition-colors"
                />
              </div>

              {/* Bulk actions */}
              <div className="flex items-center gap-2 mb-3">
                <button
                  onClick={selectAll}
                  className="text-[10px] font-black uppercase tracking-widest text-secondary hover:underline"
                >
                  Select All
                </button>
                <span className="text-muted-foreground/20">|</span>
                <button
                  onClick={deselectAll}
                  className="text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:underline"
                >
                  Clear
                </button>
              </div>

              {/* All-mode banner */}
              {mode === "all" && (
                <div className="flex items-center gap-3 px-4 py-3 mb-3 rounded-xl bg-secondary/5 border border-secondary/15">
                  <Database className="w-4 h-4 text-secondary shrink-0" />
                  <p className="text-[11px] font-bold text-muted-foreground">
                    All resources shown below will be synced. Switch to <span className="text-primary">Select Resources</span> to pick specific items.
                  </p>
                </div>
              )}

              {/* Resource list */}
              <div className="space-y-1">
                {filteredResources.map((resource) => (
                  <ResourceRow
                    key={resource.id}
                    resource={resource}
                    depth={0}
                    selected={selected}
                    expanded={expanded}
                    childrenMap={childrenMap}
                    childrenLoading={childrenLoading}
                    onToggleExpand={toggleExpanded}
                    onToggleSelect={toggleSelected}
                  />
                ))}
                {filteredResources.length === 0 && (
                  <p className="text-center text-sm text-muted-foreground/60 py-8">
                    No resources found.
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-8 pt-4 border-t border-white/5">
          <Button
            variant="outline"
            onClick={onClose}
            className="h-12 px-6 rounded-xl border-white/10 hover:bg-white/5 font-bold"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || (mode === "selected" && selected.size === 0)}
            className="h-12 px-8 rounded-xl bg-secondary hover:bg-secondary/90 text-white font-black uppercase tracking-widest text-[11px] gap-2 shadow-lg shadow-secondary/20"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Save & Sync
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Tree row component -------------------------------------

function ResourceRow({
  resource,
  depth,
  selected,
  expanded,
  childrenMap,
  childrenLoading,
  onToggleExpand,
  onToggleSelect,
}: {
  resource: BrowsableResource;
  depth: number;
  selected: Map<string, BrowsableResource>;
  expanded: Set<string>;
  childrenMap: Map<string, BrowsableResource[]>;
  childrenLoading: Set<string>;
  onToggleExpand: (r: BrowsableResource) => void;
  onToggleSelect: (r: BrowsableResource) => void;
}) {
  const isSelected = selected.has(resource.id);
  const isExpanded = expanded.has(resource.id);
  const isLoading = childrenLoading.has(resource.id);
  const children = childrenMap.get(resource.id) ?? [];

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-xl transition-all cursor-pointer group",
          isSelected
            ? "bg-secondary/10 border border-secondary/20"
            : "hover:bg-white/5 border border-transparent"
        )}
        style={{ paddingLeft: `${depth * 24 + 12}px` }}
      >
        {/* Expand toggle */}
        {resource.hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(resource);
            }}
            className="w-5 h-5 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
          >
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>
        ) : (
          <div className="w-5" />
        )}

        {/* Checkbox */}
        <button
          onClick={() => onToggleSelect(resource)}
          className={cn(
            "w-5 h-5 rounded-md border flex items-center justify-center transition-all",
            isSelected
              ? "bg-secondary border-secondary"
              : "border-white/20 hover:border-secondary/50"
          )}
        >
          {isSelected && <Check className="w-3 h-3 text-white" />}
        </button>

        <ResourceIcon type={resource.type} />
        <span
          className={cn(
            "text-sm font-medium flex-1 truncate",
            isSelected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
          )}
          onClick={() => onToggleSelect(resource)}
        >
          {resource.name}
        </span>

        {resource.metadata?.memberCount ? (
          <span className="text-[10px] text-muted-foreground/50 font-bold">
            {String(resource.metadata.memberCount)} members
          </span>
        ) : null}
        {resource.metadata?.language ? (
          <Badge className="bg-white/5 border-none text-[9px] font-bold text-muted-foreground/60 px-2 h-5">
            {String(resource.metadata.language)}
          </Badge>
        ) : null}
      </div>

      {/* Children */}
      {isExpanded &&
        children.map((child) => (
          <ResourceRow
            key={child.id}
            resource={child}
            depth={depth + 1}
            selected={selected}
            expanded={expanded}
            childrenMap={childrenMap}
            childrenLoading={childrenLoading}
            onToggleExpand={onToggleExpand}
            onToggleSelect={onToggleSelect}
          />
        ))}
    </div>
  );
}
