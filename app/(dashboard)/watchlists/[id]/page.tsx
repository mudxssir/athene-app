"use client";

import { useState, useEffect, useCallback, use } from "react";
import Link from "next/link";
import { ArrowLeft, Play, Loader2, Clock, CheckCheck, AlertTriangle, Info, Zap } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Watchlist, WatchlistAlert } from "@/lib/watchlists/types";

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-destructive/10 text-destructive border-destructive/20",
  warning:  "bg-amber-500/10 text-amber-500 border-amber-500/20",
  info:     "bg-primary/10 text-primary border-primary/20",
};

const SEVERITY_ICON = {
  critical: AlertTriangle,
  warning:  AlertTriangle,
  info:     Info,
};

export default function WatchlistDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [alerts, setAlerts]       = useState<WatchlistAlert[]>([]);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning]     = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res  = await fetch(`/api/watchlists/${id}`);
      if (!res.ok) throw new Error(res.status === 404 ? "Watchlist not found" : "Failed to load watchlist");
      const json = await res.json();
      setWatchlist(json.watchlist ?? null);
      setAlerts(json.alerts ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load watchlist");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function handleRun() {
    setRunning(true);
    try {
      const res  = await fetch(`/api/watchlists/${id}/run`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      toast.success(json.changed ? `Alert: ${json.severity} change detected` : "No changes — answer is the same");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  async function markRead(alertId: string) {
    const res = await fetch(`/api/watchlists/alerts/${alertId}`, { method: "PATCH" });
    if (!res.ok) { toast.error("Failed to mark alert as read"); return; }
    setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, is_read: true } : a));
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4 animate-pulse max-w-4xl mx-auto w-full">
        <div className="h-6 w-48 rounded-xl bg-muted" />
        <div className="h-32 rounded-2xl bg-muted" />
        <div className="space-y-3">
          {[0,1,2].map((i) => <div key={i} className="h-24 rounded-2xl bg-muted" />)}
        </div>
      </div>
    );
  }

  if (loadError || !watchlist) {
    return (
      <div className="p-6 max-w-4xl mx-auto w-full text-center py-20 space-y-3">
        <p className="text-muted-foreground">{loadError ?? "Watchlist not found."}</p>
        <div className="flex items-center justify-center gap-4">
          {loadError && (
            <button onClick={load} className="text-primary text-sm hover:underline inline-flex items-center gap-1">
              Try again
            </button>
          )}
          <Link href="/watchlists" className="text-muted-foreground text-sm hover:underline">
            Back to watchlists
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto w-full">
      {/* Back + Header */}
      <div>
        <Link
          href="/watchlists"
          className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground hover:text-foreground transition-colors mb-4"
        >
          <ArrowLeft size={12} /> Watchlists
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3">
              <div className={cn("h-2.5 w-2.5 rounded-full", watchlist.is_active ? "bg-green-500" : "bg-muted-foreground/40")} />
              <h1 className="text-2xl font-black uppercase tracking-[-0.02em]">{watchlist.name}</h1>
            </div>
            <p className="mt-2 text-sm text-muted-foreground max-w-2xl">{watchlist.query}</p>
          </div>

          <button
            onClick={handleRun}
            disabled={running}
            className={cn(
              "inline-flex items-center gap-2 h-11 px-6 rounded-2xl",
              "bg-primary text-white text-[11px] font-extrabold uppercase tracking-[0.22em]",
              "hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />}
            Run Now
          </button>
        </div>
      </div>

      {/* Current answer */}
      {watchlist.last_answer && (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={13} className="text-primary" />
            <span className="text-[10px] font-extrabold uppercase tracking-[0.3em] text-muted-foreground">Current Answer</span>
            {watchlist.last_run_at && (
              <span className="ml-auto text-[10px] text-muted-foreground/60 flex items-center gap-1">
                <Clock size={10} />
                {new Date(watchlist.last_run_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
              </span>
            )}
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{watchlist.last_answer}</p>
        </div>
      )}

      {/* Alert history */}
      <div>
        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.35em] text-muted-foreground mb-3">
          Alert History ({alerts.length})
        </h2>

        {alerts.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted-foreground text-sm">
            No alerts yet — run the watchlist to check for changes.
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => {
              const SevIcon = SEVERITY_ICON[alert.severity] ?? Info;
              return (
                <div
                  key={alert.id}
                  className={cn(
                    "rounded-2xl border bg-card p-5 transition-all",
                    !alert.is_read ? "border-primary/30 bg-primary/5" : "border-border"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <div className={cn("mt-0.5 h-7 w-7 rounded-xl flex items-center justify-center shrink-0 border", SEVERITY_STYLES[alert.severity])}>
                      <SevIcon size={13} />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 flex-wrap mb-1">
                        <span className={cn("inline-flex h-5 px-2 rounded-full border text-[10px] font-bold items-center", SEVERITY_STYLES[alert.severity])}>
                          {alert.severity}
                        </span>
                        <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
                          <Clock size={9} />
                          {new Date(alert.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                        </span>
                        {!alert.is_read && (
                          <button
                            onClick={() => markRead(alert.id)}
                            className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground hover:text-primary transition-colors"
                          >
                            <CheckCheck size={10} /> Mark read
                          </button>
                        )}
                      </div>

                      <p className="text-sm font-medium">{alert.change_summary}</p>

                      {alert.new_answer && (
                        <div className="mt-3 space-y-2">
                          <div className="rounded-xl bg-background border border-border p-3">
                            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-1">New Answer</p>
                            <p className="text-sm">{alert.new_answer}</p>
                          </div>
                          {alert.previous_answer && (
                            <div className="rounded-xl bg-muted/50 border border-border p-3 opacity-60">
                              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-1">Previous</p>
                              <p className="text-sm">{alert.previous_answer}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
