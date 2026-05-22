"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { CheckCircle2, Loader2, ArrowRight, Database, AlertCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Integration {
  connectionId: string;
  displayName: string;
  status: "connected" | "syncing" | "error" | string;
  totalDocs: number;
}

const POLL_INTERVAL = 5000;
const TIMEOUT_MS = 90000;

export default function OnboardingSyncingPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [allDone, setAllDone] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/integrations");
      if (!res.ok) return;
      const { integrations: data } = await res.json();
      const list: Integration[] = data ?? [];
      setIntegrations(list);
      setLoading(false);

      const isSyncing = list.some((i) => i.status === "syncing");
      if (list.length > 0 && !isSyncing) {
        setAllDone(true);
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    } catch {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(() => {
      if (Date.now() - startedAt.current > TIMEOUT_MS) {
        setTimedOut(true);
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        return;
      }
      fetchStatus();
    }, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus]);

  const stillSyncing = integrations.some((i) => i.status === "syncing");
  const canContinue = allDone || timedOut;

  const statusIcon = (status: string) => {
    if (status === "syncing") return <Loader2 className="w-4 h-4 text-secondary animate-spin" />;
    if (status === "error") return <AlertCircle className="w-4 h-4 text-amber-400" />;
    return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
  };

  const statusLabel = (status: string) => {
    if (status === "syncing") return "Syncing…";
    if (status === "error") return "Sync issue";
    return "Ready";
  };

  return (
    <div className="min-h-screen bg-[#06080c] text-white flex flex-col font-['Space_Grotesk'] overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[600px] bg-secondary/5 blur-[160px] -z-10 rounded-full opacity-50" />

      {/* Progress Bar — step 3 of 4 */}
      <div className="h-1.5 w-full bg-white/5 fixed top-0 left-0 z-50">
        <div className="h-full bg-primary transition-all duration-1000" style={{ width: "75%" }} />
      </div>

      <main className="flex-1 container max-w-2xl mx-auto flex flex-col items-center justify-center p-6 pt-20 pb-16">

        <div className="w-full text-center space-y-5 mb-12 animate-in fade-in slide-in-from-bottom-8 duration-700">
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className="text-[10px] font-black uppercase tracking-[0.3em] text-secondary">Step 3 of 4 — Indexing</span>
          </div>

          <h1 className="text-4xl md:text-5xl font-black tracking-tighter">
            {allDone ? (
              <>Sources <span className="text-emerald-400">indexed</span></>
            ) : (
              <>Building your <span className="text-gradient">knowledge base</span></>
            )}
          </h1>

          <p className="text-slate-400 max-w-lg mx-auto font-medium">
            {allDone
              ? "All connected sources have been indexed and are ready to query."
              : timedOut
              ? "Indexing is taking longer than usual — normal for large workspaces. You can continue and indexing will finish in the background."
              : "Athene is reading and indexing your connected sources. This usually takes 1–3 minutes."}
          </p>
        </div>

        {/* Integration Status List */}
        <div className="w-full space-y-3 mb-12 animate-in fade-in slide-in-from-bottom-10 duration-900 delay-150">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-secondary animate-spin" />
            </div>
          ) : integrations.length === 0 ? (
            <div className="text-center py-10 text-slate-500 text-sm space-y-3">
              <p>No connected sources found.</p>
              <Link href="/onboarding/connections" className="text-secondary hover:underline font-bold text-xs uppercase tracking-widest">
                ← Go back and connect a source
              </Link>
            </div>
          ) : (
            integrations.map((integration) => (
              <div
                key={integration.connectionId}
                className={cn(
                  "flex items-center justify-between px-6 py-4 rounded-2xl border transition-all",
                  integration.status === "syncing"
                    ? "bg-secondary/5 border-secondary/20"
                    : integration.status === "error"
                    ? "bg-amber-400/5 border-amber-400/20"
                    : "bg-emerald-400/5 border-emerald-400/20"
                )}
              >
                <div className="flex items-center gap-4">
                  <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center">
                    <Database className="w-4 h-4 text-slate-400" />
                  </div>
                  <div>
                    <p className="font-bold text-sm">{integration.displayName}</p>
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest">
                      {integration.totalDocs > 0
                        ? `${integration.totalDocs.toLocaleString()} docs indexed`
                        : "Awaiting index"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {statusIcon(integration.status)}
                  <span
                    className={cn(
                      "text-[10px] font-black uppercase tracking-widest",
                      integration.status === "syncing" ? "text-secondary"
                        : integration.status === "error" ? "text-amber-400"
                        : "text-emerald-400"
                    )}
                  >
                    {statusLabel(integration.status)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* CTA */}
        <div className="flex flex-col items-center gap-4 animate-in fade-in duration-1000 delay-300">
          {canContinue ? (
            <>
              {timedOut && stillSyncing && (
                <p className="text-[10px] text-amber-400 font-bold uppercase tracking-widest mb-1">
                  Indexing still in progress — will complete in the background
                </p>
              )}
              <Button
                asChild
                size="lg"
                className="h-16 px-12 rounded-2xl bg-secondary text-black hover:opacity-90 font-black uppercase tracking-widest text-[11px] gap-3 shadow-2xl shadow-[var(--shadow-2)] group"
              >
                <Link href="/onboarding/ready">
                  Continue
                  <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
                </Link>
              </Button>
            </>
          ) : (
            <div className="flex items-center gap-3 text-slate-500 text-xs font-medium">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              Checking every 5 seconds…
            </div>
          )}
          {!canContinue && (
            <Link
              href="/dashboard"
              className="text-[10px] font-black uppercase tracking-widest text-slate-600 hover:text-slate-400 transition-colors"
            >
              Skip — go to dashboard
            </Link>
          )}
        </div>
      </main>

      {/* Step indicator */}
      <div className="pb-8 flex items-center justify-center gap-2">
        {[1, 2, 3, 4].map((step) => (
          <div
            key={step}
            className={cn(
              "rounded-full transition-all",
              step <= 3 ? "w-6 h-2 bg-secondary" : "w-2 h-2 bg-white/10"
            )}
          />
        ))}
      </div>
    </div>
  );
}
