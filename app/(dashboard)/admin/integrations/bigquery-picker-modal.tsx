"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  X,
  Loader2,
  Search,
  AlertCircle,
  CheckSquare,
  Square,
  Database,
  Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface BigQueryTable {
  dataset: string;
  name: string;
  fullName: string; // "dataset.table"
}

interface BigQueryPickerModalProps {
  open: boolean;
  connectionId: string; // Supabase connections.id UUID
  onClose: () => void;
  onSuccess: () => void;
}

export function BigQueryPickerModal({ open, connectionId, onClose, onSuccess }: BigQueryPickerModalProps) {
  const [tables, setTables] = useState<BigQueryTable[]>([]);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const loadTables = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/connections/${connectionId}/browse?type=bigquery_tables`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) setError(data.error);
      setTables(data.tables ?? []);
    } catch (e: any) {
      setError(e.message ?? "Failed to load BigQuery tables");
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (open) {
      setSelectedTables(new Set());
      setSearch("");
      setError(null);
      loadTables();
    }
  }, [open, loadTables]);

  const groupedTables = useMemo(() => {
    const lower = search.toLowerCase();
    const filtered = search
      ? tables.filter((t) => t.fullName.toLowerCase().includes(lower))
      : tables;

    const groups: Record<string, BigQueryTable[]> = {};
    for (const t of filtered) {
      if (!groups[t.dataset]) groups[t.dataset] = [];
      groups[t.dataset].push(t);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [tables, search]);

  const toggleTable = (fullName: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  };

  const toggleDataset = (datasetTables: BigQueryTable[]) => {
    const allSelected = datasetTables.every((t) => selectedTables.has(t.fullName));
    setSelectedTables((prev) => {
      const next = new Set(prev);
      datasetTables.forEach((t) => (allSelected ? next.delete(t.fullName) : next.add(t.fullName)));
      return next;
    });
  };

  const handleSave = async () => {
    if (selectedTables.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/connections/${connectionId}/configure`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "bigquery",
          allowlist: Array.from(selectedTables),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onSuccess();
      onClose();
    } catch (e: any) {
      setError(e.message ?? "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-300">
      <div className="bg-card border border-white/10 shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden rounded-[2.5rem] animate-in zoom-in-95 duration-300">

        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-white/5 flex-shrink-0">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-2xl font-black text-foreground tracking-tight">Select Tables to Index</h2>
              <p className="text-xs text-muted-foreground font-bold mt-1">
                Choose which BigQuery tables Athene should embed and make searchable.
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full hover:bg-white/5 -mt-1">
              <X className="w-5 h-5 text-muted-foreground" />
            </Button>
          </div>

          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/40" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter tables..."
              className="w-full h-11 pl-11 pr-4 bg-white/5 border border-white/10 rounded-2xl text-sm font-bold placeholder:text-muted-foreground/30 text-foreground outline-none focus:border-primary/30 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Table List */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-8 py-4">
            {loading && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/40" />
              </div>
            )}

            {error && (
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-destructive/10 border border-destructive/20 mb-4">
                <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                <div>
                  <span className="text-sm text-destructive font-bold block">{error}</span>
                  {error.toLowerCase().includes("permission") && (
                    <span className="text-xs text-destructive/70 font-medium">
                      Ensure your service account has BigQuery Data Viewer on the datasets.
                    </span>
                  )}
                </div>
              </div>
            )}

            {!loading && groupedTables.length === 0 && !error && (
              <div className="py-12 text-center">
                <Database className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
                <p className="text-sm font-bold text-muted-foreground/40">
                  {search ? "No tables match your search" : "No tables found in this project"}
                </p>
              </div>
            )}

            <div className="space-y-6">
              {groupedTables.map(([dataset, datasetTables]) => {
                const allSelected = datasetTables.every((t) => selectedTables.has(t.fullName));

                return (
                  <div key={dataset}>
                    <div className="flex items-center justify-between mb-2 pb-2 border-b border-white/5">
                      <div className="flex items-center gap-2">
                        <Database className="w-3.5 h-3.5 text-secondary" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                          {dataset}
                        </span>
                        <span className="text-[9px] font-bold text-muted-foreground/40">
                          ({datasetTables.length} table{datasetTables.length !== 1 ? "s" : ""})
                        </span>
                      </div>
                      <button
                        onClick={() => toggleDataset(datasetTables)}
                        className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40 hover:text-primary transition-colors flex items-center gap-1"
                      >
                        {allSelected
                          ? <><CheckSquare className="w-3 h-3" /> Deselect all</>
                          : <><Square className="w-3 h-3" /> Select all</>}
                      </button>
                    </div>

                    <div className="space-y-1">
                      {datasetTables.map((table) => {
                        const isSelected = selectedTables.has(table.fullName);
                        return (
                          <button
                            key={table.fullName}
                            onClick={() => toggleTable(table.fullName)}
                            className={`w-full flex items-center gap-3 p-3 rounded-2xl transition-all text-left ${
                              isSelected
                                ? "bg-primary/10 border border-primary/20"
                                : "hover:bg-white/5 border border-transparent"
                            }`}
                          >
                            {isSelected
                              ? <CheckSquare className="w-4 h-4 text-primary flex-shrink-0" />
                              : <Square className="w-4 h-4 text-muted-foreground/40 flex-shrink-0" />}
                            <Table2 className="w-4 h-4 text-primary/60 flex-shrink-0" />
                            <span className="text-sm font-bold text-foreground">{table.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="px-8 py-6 border-t border-white/5 flex items-center justify-between flex-shrink-0">
          <span className="text-xs font-bold text-muted-foreground/60">
            {selectedTables.size > 0
              ? `${selectedTables.size} table${selectedTables.size !== 1 ? "s" : ""} selected`
              : "No tables selected"}
          </span>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={onClose}
              className="h-10 px-5 rounded-xl border-white/10 hover:bg-white/5 font-bold text-sm"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || selectedTables.size === 0}
              className="h-10 px-6 rounded-xl bg-primary hover:bg-primary/90 text-white font-black text-sm gap-2 shadow-lg shadow-primary/20"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              Save & Sync
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
