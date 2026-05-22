"use client";

import { useState, useEffect } from "react";
import {
  Database,
  MessageSquare,
  Activity,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Sun,
  ShieldCheck,
  Loader2,
  BarChart2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface UsageData {
  docs: { total: number; by_source: Record<string, number> };
  connections: {
    total: number;
    by_status: { active: number; syncing: number; error: number };
    list: Array<{ provider: string; source_type: string; status: string; last_synced_at: string | null }>;
  };
  queries: { total_threads: number; total_messages: number; active_threads_7d: number };
  briefings: { this_month: number };
  hitl: { total: number; approved: number; rejected: number; edited: number };
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color = "text-secondary",
  bg = "bg-secondary/10",
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  bg?: string;
}) {
  return (
    <div className="rounded-3xl bg-card border border-white/5 p-6 flex flex-col gap-4">
      <div className={cn("w-10 h-10 rounded-2xl flex items-center justify-center", bg)}>
        <Icon className={cn("w-5 h-5", color)} />
      </div>
      <div>
        <p className="text-2xl font-black tracking-tight">{value}</p>
        <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 mt-0.5">{label}</p>
        {sub && <p className="text-xs text-muted-foreground/40 mt-1">{sub}</p>}
      </div>
    </div>
  );
}

function statusColor(status: string) {
  if (status === "active") return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
  if (status === "syncing") return "text-blue-400 bg-blue-400/10 border-blue-400/20";
  return "text-amber-400 bg-amber-400/10 border-amber-400/20";
}

export default function UsagePage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchUsage() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/usage");
      if (!res.ok) throw new Error("Failed to load usage data");
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchUsage(); }, []);

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-2xl bg-secondary/10 flex items-center justify-center">
              <BarChart2 className="w-5 h-5 text-secondary" />
            </div>
            <h1 className="text-3xl font-black tracking-tight">Usage</h1>
          </div>
          <p className="text-muted-foreground/60 text-sm">Knowledge base health, query activity, and integration status.</p>
        </div>
        <button
          onClick={fetchUsage}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-widest border border-white/10 hover:border-white/20 transition-all disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 text-secondary animate-spin" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {data && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <StatCard
              icon={Database}
              label="Total Documents"
              value={data.docs.total.toLocaleString()}
              color="text-secondary"
              bg="bg-secondary/10"
            />
            <StatCard
              icon={Activity}
              label="Active Connections"
              value={data.connections.by_status.active}
              sub={`${data.connections.total} total`}
              color="text-emerald-400"
              bg="bg-emerald-400/10"
            />
            <StatCard
              icon={MessageSquare}
              label="Total Queries"
              value={data.queries.total_messages.toLocaleString()}
              sub={`${data.queries.active_threads_7d} threads active (7d)`}
              color="text-primary"
              bg="bg-primary/10"
            />
            <StatCard
              icon={Sun}
              label="Briefings This Month"
              value={data.briefings.this_month}
              color="text-amber-400"
              bg="bg-amber-400/10"
            />
            <StatCard
              icon={ShieldCheck}
              label="HITL Decisions"
              value={data.hitl.total}
              sub={`${data.hitl.approved} approved · ${data.hitl.rejected} rejected`}
              color="text-primary"
              bg="bg-primary/10"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Docs by source */}
            <div className="rounded-3xl bg-card border border-white/5 p-6">
              <h2 className="font-black text-sm uppercase tracking-widest text-muted-foreground/60 mb-5">
                Documents by Source
              </h2>
              {Object.keys(data.docs.by_source).length === 0 ? (
                <p className="text-sm text-muted-foreground/40">No documents indexed yet.</p>
              ) : (
                <div className="space-y-3">
                  {Object.entries(data.docs.by_source)
                    .sort(([, a], [, b]) => b - a)
                    .map(([source, count]) => {
                      const pct = data.docs.total > 0 ? Math.round((count / data.docs.total) * 100) : 0;
                      return (
                        <div key={source}>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-bold capitalize">{source.replace(/_/g, " ")}</span>
                            <span className="text-xs text-muted-foreground/50">{count.toLocaleString()} <span className="text-muted-foreground/30">({pct}%)</span></span>
                          </div>
                          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Connection status */}
            <div className="rounded-3xl bg-card border border-white/5 p-6">
              <h2 className="font-black text-sm uppercase tracking-widest text-muted-foreground/60 mb-5">
                Integration Health
              </h2>
              {data.connections.list.length === 0 ? (
                <p className="text-sm text-muted-foreground/40">No integrations connected.</p>
              ) : (
                <div className="space-y-2">
                  {data.connections.list.map((conn, i) => (
                    <div key={i} className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0">
                      <div>
                        <p className="text-sm font-bold capitalize">{conn.provider.replace(/_/g, " ")}</p>
                        <p className="text-[10px] text-muted-foreground/40 uppercase tracking-widest">
                          {conn.last_synced_at
                            ? `Last synced ${new Date(conn.last_synced_at).toLocaleDateString()}`
                            : "Never synced"}
                        </p>
                      </div>
                      <Badge className={cn("rounded-full px-2.5 py-0.5 font-black text-[9px] uppercase tracking-widest border", statusColor(conn.status))}>
                        {conn.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Connection status errors callout */}
          {data.connections.by_status.error > 0 && (
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-amber-400/5 border border-amber-400/20">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <p className="text-sm text-amber-400 font-medium">
                {data.connections.by_status.error} integration{data.connections.by_status.error > 1 ? "s" : ""} failed their last sync.{" "}
                <a href="/admin/integrations" className="underline underline-offset-2 font-bold hover:opacity-80">
                  Review in Integrations →
                </a>
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
