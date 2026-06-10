"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SCHEDULES = [
  { label: "Every hour",    value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily 9am",     value: "0 9 * * *" },
  { label: "Daily 6am",     value: "0 6 * * *" },
  { label: "Weekdays 9am",  value: "0 9 * * 1-5" },
];

interface Props {
  onCreated?: () => void;
  /** Pre-fill the name field and open the dialog immediately. */
  initialName?: string;
  /** Pre-fill the query field and open the dialog immediately. */
  initialQuery?: string;
  /** Replace the default "+ New Watchlist" trigger with a custom element. */
  trigger?: React.ReactNode;
}

export function WatchlistCreate({ onCreated, initialName, initialQuery, trigger }: Props) {
  const [open, setOpen]         = useState(() => !!(initialName || initialQuery));
  const [name, setName]         = useState(initialName ?? "");
  const [query, setQuery]       = useState(initialQuery ?? "");
  const [schedule, setSchedule] = useState(SCHEDULES[1].value);
  const [loading, setLoading]   = useState(false);

  function handleOpen() {
    if (initialName && !name) setName(initialName);
    if (initialQuery && !query) setQuery(initialQuery);
    setOpen(true);
  }

  async function handleCreate() {
    if (!name.trim() || !query.trim()) {
      toast.error("Name and query are required");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, query, schedule }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      toast.success("Watchlist created");
      setOpen(false);
      setName(""); setQuery(""); setSchedule(SCHEDULES[1].value);
      onCreated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create watchlist");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {trigger ? (
        <span onClick={handleOpen} style={{ cursor: "pointer" }}>{trigger}</span>
      ) : (
        <button
          onClick={handleOpen}
          className={cn(
            "inline-flex items-center gap-2 h-11 px-6 rounded-2xl",
            "bg-primary text-white text-[11px] font-extrabold uppercase tracking-[0.22em]",
            "hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20"
          )}
        >
          <Plus size={14} />
          New Watchlist
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setOpen(false)}>
          <div className="w-full max-w-lg bg-card border border-border rounded-3xl shadow-2xl p-6 space-y-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-black uppercase tracking-[-0.02em]">New Watchlist</h2>
              <button
                onClick={() => setOpen(false)}
                className="h-8 w-8 rounded-xl flex items-center justify-center hover:bg-muted transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-extrabold uppercase tracking-[0.3em] text-muted-foreground">
                  Name
                </label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Revenue blockers, Sprint health"
                  className={cn(
                    "w-full h-11 px-4 rounded-2xl bg-background border border-border",
                    "text-sm placeholder:text-muted-foreground/50 outline-none",
                    "focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-extrabold uppercase tracking-[0.3em] text-muted-foreground">
                  Query — what should Athene watch?
                </label>
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  rows={3}
                  placeholder="e.g. What are the current blockers affecting the Q3 launch?"
                  className={cn(
                    "w-full px-4 py-3 rounded-2xl bg-background border border-border",
                    "text-sm placeholder:text-muted-foreground/50 outline-none resize-none",
                    "focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-extrabold uppercase tracking-[0.3em] text-muted-foreground">
                  Check frequency
                </label>
                <div className="flex flex-wrap gap-2">
                  {SCHEDULES.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setSchedule(s.value)}
                      className={cn(
                        "h-8 px-4 rounded-xl text-[11px] font-bold uppercase tracking-[0.15em] border transition-all",
                        schedule === s.value
                          ? "bg-primary/10 border-primary text-primary"
                          : "bg-muted border-border text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 pt-1">
              <button
                onClick={handleCreate}
                disabled={loading}
                className={cn(
                  "flex-1 h-11 rounded-2xl bg-primary text-white",
                  "text-[11px] font-extrabold uppercase tracking-[0.22em]",
                  "hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20",
                  "disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
                )}
              >
                {loading && <Loader2 size={14} className="animate-spin" />}
                Create Watchlist
              </button>
              <button
                onClick={() => setOpen(false)}
                className="h-11 px-5 rounded-2xl border border-border text-[11px] font-bold uppercase tracking-[0.22em] hover:bg-muted transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
