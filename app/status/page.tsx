"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { CheckCircle2, AlertCircle, XCircle, RefreshCw, Loader2, Zap, Database, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface HealthStatus {
  status: "ok" | "degraded" | "down";
  db: "ok" | "fail";
  embedder: "ok" | "fail";
  qstash: "ok" | "fail";
  latency_ms: number;
  ts: string;
  errors: string[];
}

const SERVICE_META: Record<string, { label: string; description: string; icon: ReactNode }> = {
  db: {
    label: "Database",
    description: "Supabase PostgreSQL — primary data store",
    icon: <Database className="w-5 h-5" />,
  },
  embedder: {
    label: "Embedder",
    description: "Jina AI — semantic search & retrieval",
    icon: <Cpu className="w-5 h-5" />,
  },
  qstash: {
    label: "Job Queue",
    description: "QStash — background workers & watchlists",
    icon: <Zap className="w-5 h-5" />,
  },
};

function ServiceRow({ name, statusValue }: { name: string; statusValue: "ok" | "fail" }) {
  const meta = SERVICE_META[name];
  const ok = statusValue === "ok";
  return (
    <div className="flex items-center justify-between py-5 border-b border-white/5 last:border-0">
      <div className="flex items-center gap-4">
        <div className={cn("p-2.5 rounded-xl border", ok ? "bg-emerald-400/10 border-emerald-400/20 text-emerald-400" : "bg-red-400/10 border-red-400/20 text-red-400")}>
          {meta?.icon}
        </div>
        <div>
          <p className="text-sm font-black text-foreground">{meta?.label ?? name}</p>
          <p className="text-[11px] text-muted-foreground/50 font-medium">{meta?.description}</p>
        </div>
      </div>
      <div className={cn("flex items-center gap-2 text-[11px] font-black uppercase tracking-widest px-3 py-1.5 rounded-full border", ok ? "bg-emerald-400/10 border-emerald-400/20 text-emerald-400" : "bg-red-400/10 border-red-400/20 text-red-400")}>
        {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
        {ok ? "Operational" : "Down"}
      </div>
    </div>
  );
}

const OVERALL_CONFIG = {
  ok: {
    color: "text-emerald-400",
    bg: "bg-emerald-400/10 border-emerald-400/20",
    icon: <CheckCircle2 className="w-6 h-6" />,
    label: "All Systems Operational",
  },
  degraded: {
    color: "text-amber-400",
    bg: "bg-amber-400/10 border-amber-400/20",
    icon: <AlertCircle className="w-6 h-6" />,
    label: "Partial Degradation",
  },
  down: {
    color: "text-red-400",
    bg: "bg-red-400/10 border-red-400/20",
    icon: <XCircle className="w-6 h-6" />,
    label: "Major Outage",
  },
};

export default function StatusPage() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const fetchHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/health");
      const data: HealthStatus = await res.json();
      setHealth(data);
      setLastChecked(new Date());
    } catch {
      setError("Unable to reach health endpoint.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 60_000);
    return () => clearInterval(interval);
  }, []);

  const overall = health ? OVERALL_CONFIG[health.status] : null;

  return (
    <div className="min-h-screen bg-[#06080c] text-white flex flex-col font-['Space_Grotesk']">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-4xl h-[400px] bg-secondary/5 blur-[160px] -z-10 rounded-full opacity-40" />

      <main className="flex-1 container max-w-2xl mx-auto px-6 py-20">
        {/* Header */}
        <div className="text-center mb-16 space-y-3">
          <div className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.3em] text-secondary mb-4">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-secondary animate-pulse" />
            Live System Status
          </div>
          <h1 className="text-4xl font-black tracking-tighter">Athene Status</h1>
          <p className="text-slate-500 text-sm font-medium">Real-time health of all platform services</p>
        </div>

        {/* Overall banner */}
        <div className={cn("rounded-2xl border p-6 flex items-center justify-between mb-8", overall?.bg ?? "bg-white/5 border-white/10")}>
          <div className={cn("flex items-center gap-4", overall?.color ?? "text-white")}>
            {loading ? <Loader2 className="w-6 h-6 animate-spin text-slate-400" /> : error ? <XCircle className="w-6 h-6 text-red-400" /> : overall?.icon}
            <div>
              <p className="font-black text-lg tracking-tight">
                {loading ? "Checking…" : error ? "Status Unavailable" : overall?.label}
              </p>
              {health && !loading && (
                <p className="text-[11px] font-medium opacity-60 mt-0.5">
                  Response time: {health.latency_ms}ms
                </p>
              )}
            </div>
          </div>
          <Button
            onClick={fetchHealth}
            disabled={loading}
            variant="ghost"
            className="h-9 px-4 rounded-xl text-[11px] font-black uppercase tracking-widest text-slate-400 hover:text-white gap-2"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </Button>
        </div>

        {/* Services */}
        <div className="bg-white/[0.03] border border-white/5 rounded-2xl px-6 mb-8">
          {health ? (
            <>
              <ServiceRow name="db" statusValue={health.db} />
              <ServiceRow name="embedder" statusValue={health.embedder} />
              <ServiceRow name="qstash" statusValue={health.qstash} />
            </>
          ) : (
            <div className="space-y-0">
              {["db", "embedder", "qstash"].map((name) => (
                <div key={name} className="flex items-center justify-between py-5 border-b border-white/5 last:border-0">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-white/5 animate-pulse" />
                    <div className="space-y-2">
                      <div className="w-24 h-3 rounded bg-white/5 animate-pulse" />
                      <div className="w-48 h-2.5 rounded bg-white/5 animate-pulse" />
                    </div>
                  </div>
                  <div className="w-24 h-7 rounded-full bg-white/5 animate-pulse" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Error details */}
        {health?.errors && health.errors.length > 0 && (
          <div className="bg-red-400/5 border border-red-400/20 rounded-2xl p-5 mb-8">
            <p className="text-[11px] font-black uppercase tracking-widest text-red-400 mb-3">Error Details</p>
            <ul className="space-y-1.5">
              {health.errors.map((err, i) => (
                <li key={i} className="text-sm text-red-300/80 font-mono">{err}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-[11px] text-slate-600 font-medium space-y-1">
          {lastChecked && (
            <p>Last checked: {lastChecked.toLocaleTimeString()} · Auto-refreshes every 60s</p>
          )}
          {health?.ts && (
            <p className="font-mono opacity-50">Server time: {new Date(health.ts).toISOString()}</p>
          )}
        </div>
      </main>
    </div>
  );
}
