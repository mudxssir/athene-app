"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Play, Pause, Trash2, ChevronRight, Loader2, Bell, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Watchlist } from "@/lib/watchlists/types";

const SEVERITY_STYLES = {
  critical: "bg-destructive/10 text-destructive border-destructive/20",
  warning:  "bg-amber-500/10 text-amber-500 border-amber-500/20",
  info:     "bg-primary/10 text-primary border-primary/20",
};

interface Props {
  watchlist: Watchlist & { unread_count?: number };
  onRefresh: () => void;
}

export function WatchlistCard({ watchlist, onRefresh }: Props) {
  const [running,  setRunning]  = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function handleRun() {
    setRunning(true);
    try {
      const res = await fetch(`/api/watchlists/${watchlist.id}/run`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      toast.success(json.changed ? `Alert: ${json.severity} change detected` : "No changes detected");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  async function handleToggle() {
    setToggling(true);
    try {
      const res = await fetch(`/api/watchlists/${watchlist.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !watchlist.is_active }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update watchlist");
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${watchlist.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/watchlists/${watchlist.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success("Watchlist deleted");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete watchlist");
    } finally {
      setDeleting(false);
    }
  }

  const lastRun = watchlist.last_run_at
    ? new Date(watchlist.last_run_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
    : "Never";

  return (
    <div className={cn(
      "group relative rounded-2xl border bg-card p-5 transition-all hover:border-primary/30",
      watchlist.is_active ? "border-border" : "border-border/50 opacity-60"
    )}>
      <div className="flex items-start gap-4">
        {/* Left: status dot */}
        <div className={cn(
          "mt-1 h-2 w-2 rounded-full shrink-0",
          watchlist.is_active ? "bg-green-500" : "bg-muted-foreground/40"
        )} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <Link
              href={`/watchlists/${watchlist.id}`}
              className="font-black text-[13px] uppercase tracking-[-0.01em] hover:text-primary transition-colors"
            >
              {watchlist.name}
            </Link>
            {(watchlist.unread_count ?? 0) > 0 && (
              <span className={cn(
                "inline-flex items-center gap-1 h-5 px-2 rounded-full border text-[10px] font-bold",
                SEVERITY_STYLES.warning
              )}>
                <Bell size={9} />
                {watchlist.unread_count}
              </span>
            )}
          </div>

          <p className="mt-1 text-sm text-muted-foreground line-clamp-1">{watchlist.query}</p>

          <div className="mt-2 flex items-center gap-4 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/70">
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {lastRun}
            </span>
            {watchlist.last_answer && (
              <span className="line-clamp-1 max-w-xs">{watchlist.last_answer.slice(0, 80)}…</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleRun}
            disabled={running}
            title="Run now"
            className="h-8 w-8 rounded-xl flex items-center justify-center bg-muted hover:bg-primary/10 hover:text-primary transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />}
          </button>

          <button
            onClick={handleToggle}
            disabled={toggling}
            title={watchlist.is_active ? "Pause" : "Resume"}
            className="h-8 w-8 rounded-xl flex items-center justify-center bg-muted hover:bg-amber-500/10 hover:text-amber-500 transition-colors disabled:opacity-50"
          >
            {toggling ? <Loader2 size={14} className="animate-spin" /> : watchlist.is_active ? <Pause size={13} /> : <Play size={13} />}
          </button>

          <button
            onClick={handleDelete}
            disabled={deleting}
            title="Delete"
            className="h-8 w-8 rounded-xl flex items-center justify-center bg-muted hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50"
          >
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={13} />}
          </button>

          <Link
            href={`/watchlists/${watchlist.id}`}
            className="h-8 w-8 rounded-xl flex items-center justify-center bg-muted hover:bg-primary/10 hover:text-primary transition-colors"
          >
            <ChevronRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}
