"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Bell, X, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

interface Alert {
  id: string;
  watchlist_id: string;
  watchlists?: { name: string } | null;
  change_summary: string;
  severity: "info" | "warning" | "critical";
  is_read: boolean;
  created_at: string;
}

const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-destructive",
  warning:  "bg-amber-500",
  info:     "bg-primary",
};

export function AlertInbox() {
  const [alerts, setAlerts]   = useState<Alert[]>([]);
  const [open, setOpen]       = useState(false);
  const [unread, setUnread]   = useState(0);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/watchlists/alerts?unread=false");
      if (!res.ok) return;
      const json = await res.json();
      const list: Alert[] = json.alerts ?? [];
      setAlerts(list.slice(0, 20));
      setUnread(list.filter((a) => !a.is_read).length);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchAlerts();
    const t = setInterval(fetchAlerts, 60_000);
    return () => clearInterval(t);
  }, [fetchAlerts]);

  async function markRead(alertId: string) {
    await fetch(`/api/watchlists/alerts/${alertId}`, { method: "PATCH" });
    setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, is_read: true } : a));
    setUnread((n) => Math.max(0, n - 1));
  }

  async function markAllRead() {
    const unreadAlerts = alerts.filter((a) => !a.is_read);
    await Promise.all(unreadAlerts.map((a) => fetch(`/api/watchlists/alerts/${a.id}`, { method: "PATCH" })));
    setAlerts((prev) => prev.map((a) => ({ ...a, is_read: true })));
    setUnread(0);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative h-9 w-9 rounded-xl flex items-center justify-center transition-colors",
          open ? "bg-primary/10 text-primary" : "hover:bg-muted text-muted-foreground hover:text-foreground"
        )}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-primary text-white text-[9px] font-black flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-50 w-96 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-[11px] font-extrabold uppercase tracking-[0.25em]">Watchlist Alerts</span>
              <div className="flex items-center gap-2">
                {unread > 0 && (
                  <button
                    onClick={markAllRead}
                    className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
                  >
                    <CheckCheck size={12} />
                    Mark all read
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="h-6 w-6 rounded-lg flex items-center justify-center hover:bg-muted transition-colors">
                  <X size={13} />
                </button>
              </div>
            </div>

            <div className="max-h-[420px] overflow-y-auto divide-y divide-border">
              {alerts.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground text-sm">No alerts yet</div>
              ) : alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={cn(
                    "flex gap-3 px-4 py-3 transition-colors",
                    !alert.is_read ? "bg-primary/5" : "hover:bg-muted/50"
                  )}
                >
                  <div className={cn("mt-1.5 h-2 w-2 rounded-full shrink-0", SEVERITY_DOT[alert.severity])} />
                  <div className="flex-1 min-w-0">
                    <Link
                      href={`/watchlists/${alert.watchlist_id}`}
                      onClick={() => { markRead(alert.id); setOpen(false); }}
                      className="block"
                    >
                      <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
                        {alert.watchlists?.name ?? "Watchlist"}
                      </p>
                      <p className="text-sm mt-0.5 line-clamp-2">{alert.change_summary}</p>
                      <p className="text-[10px] text-muted-foreground/60 mt-1">
                        {new Date(alert.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
                      </p>
                    </Link>
                  </div>
                  {!alert.is_read && (
                    <button
                      onClick={() => markRead(alert.id)}
                      className="h-6 w-6 rounded-lg flex items-center justify-center hover:bg-muted shrink-0 transition-colors"
                      title="Mark as read"
                    >
                      <CheckCheck size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="border-t border-border px-4 py-2.5">
              <Link
                href="/watchlists"
                onClick={() => setOpen(false)}
                className="text-[10px] font-bold uppercase tracking-[0.25em] text-primary hover:underline"
              >
                View all watchlists
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
