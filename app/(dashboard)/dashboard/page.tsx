"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Activity, Cpu, Database, ChevronRight, Zap, Link2,
  MessageSquare, Upload, AlertCircle, Settings, RefreshCw,
} from "lucide-react";
import { IconTile, Chip, MetricCard, TCard } from "@/components/ui/kit";
import { fetchWithTimeout } from "@/lib/fetch-timeout";

// Module-level cache — persists across navigations within the same browser session
// so re-entering the dashboard shows data instantly rather than a blank skeleton.
type StatsPayload = {
  stats: { documents: number; knowledge_nodes: number; actions: number; integrations: number; briefings_this_month: number };
  recent_orchestrations: any[];
};
let _cachedPayload: StatsPayload | null = null;
let _lastFetched = 0;
const POLL_INTERVAL_MS = 60_000; // 60s — halved DB load vs prior 30s

/* ── Page ───────────────────────────────────────────────── */

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState(_cachedPayload?.stats ?? {
    documents: 0, knowledge_nodes: 0, actions: 0,
    integrations: 0, briefings_this_month: 0,
  });
  const [orchestrations, setOrchestrations] = useState<any[]>(_cachedPayload?.recent_orchestrations ?? []);
  // If we have cached data, start non-loading so the page renders instantly
  const [loading, setLoading] = useState(_cachedPayload === null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const isMounted = useRef(true);

  const fetchStats = useCallback(async (quiet = false) => {
    try {
      const res = await fetchWithTimeout("/api/dashboard_stats", { timeout: 15000 });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data: StatsPayload = await res.json();
      _cachedPayload = data;
      _lastFetched = Date.now();
      if (!isMounted.current) return;
      setStats(data.stats);
      setOrchestrations(data.recent_orchestrations);
      setFetchError(null);
    } catch (error: any) {
      if (!isMounted.current) return;
      setFetchError(error.message ?? "Failed to load stats");
    } finally {
      if (isMounted.current && !quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    // Skip fetch if cached data is still fresh (< poll interval old)
    const age = Date.now() - _lastFetched;
    if (age > POLL_INTERVAL_MS || _cachedPayload === null) {
      fetchStats();
    } else {
      setLoading(false);
    }
    const interval = setInterval(() => fetchStats(true), POLL_INTERVAL_MS);
    return () => {
      isMounted.current = false;
      clearInterval(interval);
    };
  }, [fetchStats]);

  // Computed client-side only to avoid SSR/client hydration mismatch
  const [dateStamp, setDateStamp] = useState("");
  useEffect(() => {
    setDateStamp(new Date().toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    }));
  }, []);

  const statusKind: Record<string, "primary" | "amber" | "outline"> = {
    Success: "primary", Failed: "outline", Edited: "amber",
  };

  return (
    <div style={{ maxWidth: 1320, margin: "0 auto", padding: "36px 40px 80px" }}>

      {/* ── Page head ─────────────────────────────────────────── */}
      <TCard i={0} className="page-head" style={{ marginBottom: 36 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 24 }}>
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.36em", textTransform: "uppercase", color: "var(--fg-muted)", marginBottom: 8 }}>
              {dateStamp}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
              <IconTile icon={Zap} size={48} tone="primary" />
              <h1 style={{ fontFamily: "var(--font-sans)", fontSize: 44, fontWeight: 800, letterSpacing: "-0.04em", textTransform: "uppercase", margin: 0, color: "var(--fg)" }}>
                Command <span style={{ color: "var(--primary)" }}>Center</span>
              </h1>
            </div>
            <p style={{ color: "var(--fg-muted)", fontSize: 15, fontWeight: 500, margin: 0 }}>
              Real-time health monitoring of the Athene knowledge pipeline.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Chip kind="success" dot>Pipeline active</Chip>
            {/* Ask Athene pill */}
            <button
              onClick={() => router.push("/chat")}
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                height: 36, padding: "0 18px", borderRadius: 99,
                background: "var(--primary)", color: "#fff",
                fontFamily: "var(--font-sans)", fontWeight: 800,
                fontSize: 10, letterSpacing: "0.28em", textTransform: "uppercase",
                border: "none", cursor: "pointer",
                boxShadow: "0 8px 20px -6px rgba(160,74,27,0.45)",
                transition: "opacity .15s",
              }}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.opacity = "0.85")}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.opacity = "1")}
            >
              <MessageSquare size={12} />
              Ask Athene
            </button>
            {/* Utility icon buttons */}
            <button
              onClick={() => fetchStats()}
              title="Refresh"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 12, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", cursor: "pointer" }}
            >
              <RefreshCw size={14} />
            </button>
            <button
              onClick={() => router.push("/admin/users")}
              title="Settings"
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 12, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", cursor: "pointer" }}
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
      </TCard>

      {/* ── Error banner ──────────────────────────────────────── */}
      {fetchError && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderRadius: 16, background: "rgba(178,58,26,.10)", border: "1px solid rgba(178,58,26,.25)", color: "var(--danger)", marginBottom: 24 }}>
          <AlertCircle size={16} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>Could not load stats: {fetchError}</span>
          <button onClick={() => fetchStats()} style={{ marginLeft: "auto", fontSize: 11, fontWeight: 800, letterSpacing: "0.2em", textTransform: "uppercase", background: "none", border: "none", color: "var(--danger)", cursor: "pointer" }}>
            Retry
          </button>
        </div>
      )}

      {/* ── 4-col metric grid ─────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 18, marginBottom: 32 }}>
        <TCard i={1}>
          <MetricCard icon={Database}  label="Indexed Documents"  value={loading ? "—" : String(stats.documents)}       tone="primary" status="Indexed" />
        </TCard>
        <TCard i={2}>
          <MetricCard icon={Cpu}       label="Knowledge Entities" value={loading ? "—" : String(stats.knowledge_nodes)} tone="amber"   status="Networked" />
        </TCard>
        <TCard i={3}>
          <MetricCard icon={Activity}  label="HITL Decisions"     value={loading ? "—" : String(stats.actions)}         tone="honey"   status="Audited" />
        </TCard>
        <TCard i={4}>
          <MetricCard icon={Link2}     label="Active Connectors"  value={loading ? "—" : String(stats.integrations)}    tone="primary" status="Live" />
        </TCard>
      </div>

      {/* ── 2-col detail grid ─────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18 }}>

        {/* Recent agent decisions */}
        <TCard i={5} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 28, padding: 28 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 22 }}>
            <span className="eyebrow">Recent agent decisions</span>
            <button
              onClick={() => router.push("/admin/audit")}
              style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.28em", textTransform: "uppercase", color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer" }}
            >
              View all →
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {loading ? (
              [...Array(3)].map((_, i) => (
                <div key={i} className="shimmer" style={{ height: 64, borderRadius: 18 }} />
              ))
            ) : orchestrations.length === 0 ? (
              <div style={{ padding: "48px 0", textAlign: "center", border: "1px dashed var(--border-strong)", borderRadius: 22 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-muted)" }}>No agent decisions yet.</p>
                <p style={{ fontSize: 11, fontWeight: 500, color: "var(--fg-subtle)", marginTop: 4 }}>HITL approvals and rejections will appear here.</p>
              </div>
            ) : (
              orchestrations.map((item, i) => (
                <div
                  key={i}
                  onClick={() => router.push("/admin/audit")}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderRadius: 18, background: "var(--bg-muted)", border: "1px solid var(--border)", cursor: "pointer", transition: "all .2s var(--ease-out)" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
                >
                  <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                    <IconTile icon={Activity} size={36} tone="primary" />
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: "-0.01em", color: "var(--fg)" }}>{item.label}</div>
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.28em", textTransform: "uppercase", color: "var(--fg-subtle)", marginTop: 4 }}>
                        {item.id} · {new Date(item.time).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Chip kind={statusKind[item.status] ?? "outline"}>{item.status}</Chip>
                    <ChevronRight size={14} style={{ color: "var(--fg-subtle)", opacity: 0.5 }} />
                  </div>
                </div>
              ))
            )}
          </div>
        </TCard>

        {/* Right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

          {/* Quick actions */}
          <TCard i={6} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 28, padding: 28 }}>
            <div className="eyebrow" style={{ marginBottom: 18 }}>Quick actions</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { icon: MessageSquare, label: "Ask Athene",        sub: "Ask anything about your data",           href: "/chat" },
                { icon: Link2,         label: "Manage connectors", sub: `${stats.integrations} active`,           href: "/admin/integrations" },
                { icon: Upload,        label: "Upload files",      sub: `${stats.documents} docs indexed`,        href: "/files" },
              ].map((a) => (
                <button
                  key={a.href}
                  onClick={() => router.push(a.href)}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, borderRadius: 18, background: "var(--bg-muted)", border: "1px solid var(--border)", cursor: "pointer", textAlign: "left", transition: "all .2s var(--ease-out)", width: "100%" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
                >
                  <IconTile icon={a.icon} size={36} tone="primary" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--fg)" }}>{a.label}</div>
                    <div style={{ fontSize: 10, color: "var(--fg-subtle)", fontWeight: 700, marginTop: 3 }}>{a.sub}</div>
                  </div>
                  <ChevronRight size={14} style={{ color: "var(--fg-subtle)", opacity: 0.5 }} />
                </button>
              ))}
            </div>
          </TCard>

          {/* Pipeline status */}
          <TCard i={7} style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 28, padding: 28 }}>
            <div className="eyebrow" style={{ marginBottom: 18 }}>Pipeline status</div>
            {[
              { label: "Document index",  ok: stats.documents > 0,       detail: stats.documents > 0 ? `${stats.documents} docs` : "No docs yet" },
              { label: "Knowledge graph", ok: stats.knowledge_nodes > 0, detail: stats.knowledge_nodes > 0 ? `${stats.knowledge_nodes} entities` : "Empty" },
              { label: "Connectors",      ok: stats.integrations > 0,    detail: stats.integrations > 0 ? `${stats.integrations} connected` : "None active" },
              { label: "BYOK rotation",   ok: false,                     detail: "Due in 14 days" },
            ].map((r) => (
              <div
                key={r.label}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px dashed var(--border)" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: r.ok ? "#4F7A2E" : "var(--secondary)", flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)" }}>{r.label}</span>
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: r.ok ? "#4F7A2E" : "var(--secondary)" }}>
                  {loading ? "—" : r.detail}
                </span>
              </div>
            ))}
          </TCard>
        </div>
      </div>
    </div>
  );
}
