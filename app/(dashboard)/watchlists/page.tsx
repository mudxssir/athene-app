"use client";

import { useState, useEffect, useCallback } from "react";
import { Eye, Bell, AlertTriangle, Info, XCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { WatchlistCreate } from "@/components/watchlists/watchlist-create";
import { WatchlistCard }   from "@/components/watchlists/watchlist-card";
import type { Watchlist }  from "@/lib/watchlists/types";

interface WatchlistWithMeta extends Watchlist {
  unread_count?: number;
}

export default function WatchlistsPage() {
  const [watchlists, setWatchlists] = useState<WatchlistWithMeta[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [wlRes, alertRes] = await Promise.all([
        fetch("/api/watchlists"),
        fetch("/api/watchlists/alerts?unread=true"),
      ]);
      if (!wlRes.ok) throw new Error("Failed to load watchlists");
      const wlJson    = await wlRes.json();
      const alertJson = await alertRes.json();

      const unreadMap: Record<string, number> = {};
      for (const a of alertJson.alerts ?? []) {
        unreadMap[a.watchlist_id] = (unreadMap[a.watchlist_id] ?? 0) + 1;
      }

      const list: WatchlistWithMeta[] = (wlJson.watchlists ?? []).map((w: Watchlist) => ({
        ...w,
        unread_count: unreadMap[w.id] ?? 0,
      }));

      setWatchlists(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load watchlists");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const active   = watchlists.filter((w) => w.is_active).length;
  const unread   = watchlists.reduce((n, w) => n + (w.unread_count ?? 0), 0);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black uppercase tracking-[-0.02em]">Watchlists</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Standing queries that alert you when answers change.
          </p>
        </div>
        <WatchlistCreate onCreated={load} />
      </div>

      {/* Stats strip */}
      <div className="flex gap-3 flex-wrap">
        {[
          { icon: Eye,           label: "Active",       value: active,             color: "text-green-500"   },
          { icon: Bell,          label: "Unread alerts",value: unread,             color: "text-primary"     },
          { icon: AlertTriangle, label: "Total",        value: watchlists.length,  color: "text-muted-foreground" },
        ].map(({ icon: Icon, label, value, color }) => (
          <div key={label} className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-card border border-border min-w-[130px]">
            <Icon size={15} className={cn("shrink-0", color)} />
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground">{label}</p>
              <p className="text-xl font-black">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
          <div className="flex items-center gap-2">
            <XCircle size={15} className="shrink-0" />
            {error}
          </div>
          <button onClick={load} className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] hover:opacity-70 transition-opacity">
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="grid gap-4">
          {[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-2xl bg-muted animate-pulse" />)}
        </div>
      ) : watchlists.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
          <div className="h-16 w-16 rounded-[1.5rem] bg-muted flex items-center justify-center">
            <Info size={28} className="text-muted-foreground" />
          </div>
          <div>
            <p className="font-bold text-foreground">No watchlists yet</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-xs">
              Create a standing query and Athene will alert you when the answer changes.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {watchlists.map((w) => (
            <WatchlistCard key={w.id} watchlist={w} onRefresh={load} />
          ))}
        </div>
      )}
    </div>
  );
}
