"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Activity, Cpu, Database, ChevronRight, Zap, Link2, MessageSquare, Upload, AlertCircle, FileText, Info } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fetchWithTimeout } from "@/lib/fetch-timeout";

/* ── Design-kit atoms (match components.jsx exactly) ─────── */

function Icon({ icon: I, size = 18 }: { icon: React.ElementType; size?: number }) {
  return <I size={size} strokeWidth={1.7} />;
}

function IconTile({ icon: I, size = 44, tone = "primary" }: { icon: React.ElementType; size?: number; tone?: "primary" | "amber" | "honey" }) {
  const t = {
    primary: { bg: "rgba(160,74,27,.10)", border: "rgba(160,74,27,.20)", color: "var(--primary)" },
    amber:   { bg: "rgba(217,122,46,.12)", border: "rgba(217,122,46,.22)", color: "var(--secondary)" },
    honey:   { bg: "rgba(230,185,40,.18)", border: "rgba(230,185,40,.32)", color: "#9E780E" },
  }[tone];
  return (
    <div style={{ width: size, height: size, borderRadius: Math.round(size * 0.32), background: t.bg, border: `1px solid ${t.border}`, display: "inline-flex", alignItems: "center", justifyContent: "center", color: t.color, flexShrink: 0 }}>
      <I size={Math.round(size * 0.5)} strokeWidth={1.7} />
    </div>
  );
}

function Chip({ kind = "outline", dot, children }: { kind?: "primary" | "amber" | "honey" | "outline" | "success"; dot?: boolean; children: React.ReactNode }) {
  const k = {
    primary: { background: "rgba(160,74,27,.10)", color: "var(--primary)", border: "1px solid rgba(160,74,27,.22)" },
    amber:   { background: "rgba(217,122,46,.12)", color: "var(--secondary)", border: "1px solid rgba(217,122,46,.22)" },
    honey:   { background: "rgba(230,185,40,.18)", color: "#9E780E", border: "1px solid rgba(230,185,40,.32)" },
    outline: { background: "transparent", color: "var(--fg-muted)", border: "1px solid var(--border-strong)" },
    success: { background: "rgba(79,122,46,.12)", color: "#4F7A2E", border: "1px solid rgba(79,122,46,.25)" },
  }[kind];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 12px", borderRadius: 999, fontFamily: "var(--font-sans)", fontWeight: 800, fontSize: 9, letterSpacing: "0.3em", textTransform: "uppercase", ...k }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor" }} />}
      {children}
    </span>
  );
}

function MetricCard({ icon: I, label, value, tone = "primary", status }: {
  icon: React.ElementType; label: string; value: string; tone?: "primary" | "amber" | "honey"; status?: string;
}) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      className="reveal"
      style={{ background: "var(--bg-elevated)", border: `1px solid ${hov ? "var(--border-strong)" : "var(--border)"}`, borderRadius: 22, padding: 22, transition: "all .25s var(--ease-out)", boxShadow: hov ? "var(--shadow-3)" : "none", cursor: "default" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <IconTile icon={I} size={42} tone={tone} />
        {status && <Chip kind={tone === "primary" ? "primary" : tone === "amber" ? "amber" : "honey"}>{status}</Chip>}
      </div>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.32em", textTransform: "uppercase", color: "var(--fg-muted)", marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "var(--font-sans)", fontSize: 36, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--fg)" }}>{value}</div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────── */

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState({ documents: 0, knowledge_nodes: 0, actions: 0, integrations: 0, briefings_this_month: 0 });
  const [orchestrations, setOrchestrations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/dashboard_stats", { timeout: 15000 });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      setStats(data.stats);
      setOrchestrations(data.recent_orchestrations);
      setFetchError(null);
    } catch (error: any) {
      setFetchError(error.message ?? "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const statusKind: Record<string, "primary" | "amber" | "outline"> = {
    Success: "primary", Failed: "outline", Edited: "amber",
  };

  return (
    <div style={{ maxWidth: 1320, margin: "0 auto", padding: "36px 40px 80px" }}>

      {/* Header */}
      <div className="reveal reveal-1" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 36, flexWrap: "wrap", gap: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
            <IconTile icon={Zap} size={48} tone="primary" />
            <h1 style={{ fontFamily: "var(--font-sans)", fontSize: 44, fontWeight: 800, letterSpacing: "-0.04em", textTransform: "uppercase", margin: 0, color: "var(--fg)" }}>
              System <span style={{ color: "var(--primary)" }}>Overview</span>
            </h1>
          </div>
          <p style={{ color: "var(--fg-muted)", fontSize: 15, fontWeight: 500, margin: 0 }}>
            Real-time health monitoring of the Athene knowledge pipeline.
          </p>
        </div>
        <Chip kind="success" dot>Pipeline active</Chip>
      </div>

      {/* Error */}
      {fetchError && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderRadius: 16, background: "rgba(178,58,26,.10)", border: "1px solid rgba(178,58,26,.25)", color: "var(--danger)", marginBottom: 24 }}>
          <AlertCircle size={16} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>Could not load stats: {fetchError}</span>
          <button onClick={fetchStats} style={{ marginLeft: "auto", fontSize: 11, fontWeight: 800, letterSpacing: "0.2em", textTransform: "uppercase", background: "none", border: "none", color: "var(--danger)", cursor: "pointer" }}>Retry</button>
        </div>
      )}

      {/* 4-col metric grid */}
      <div className="reveal reveal-2" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 18, marginBottom: 32 }}>
        <MetricCard icon={Database}  label="Indexed Documents"   value={loading ? "—" : String(stats.documents)}       tone="primary" status="Indexed" />
        <MetricCard icon={Cpu}       label="Knowledge Entities"  value={loading ? "—" : String(stats.knowledge_nodes)} tone="amber"   status="Networked" />
        <MetricCard icon={Activity}  label="HITL Decisions"      value={loading ? "—" : String(stats.actions)}         tone="honey"   status="Audited" />
        <MetricCard icon={Link2}     label="Active Connectors"   value={loading ? "—" : String(stats.integrations)}    tone="primary" status="Live" />
      </div>

      {/* 2-col detail grid */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18 }}>

        {/* Recent agent decisions */}
        <div className="reveal reveal-3" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 28, padding: 28 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 22 }}>
            <span className="eyebrow">Recent agent decisions</span>
            <button onClick={() => router.push("/admin/audit")} style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.28em", textTransform: "uppercase", color: "var(--fg-muted)", background: "none", border: "none", cursor: "pointer" }}>
              View all →
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {loading ? (
              [...Array(3)].map((_, i) => (
                <div key={i} style={{ height: 64, borderRadius: 18, background: "var(--bg-muted)", opacity: 0.5 }} />
              ))
            ) : orchestrations.length === 0 ? (
              <div style={{ padding: "48px 0", textAlign: "center", border: "1px dashed var(--border-strong)", borderRadius: 22 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--fg-muted)" }}>No agent decisions yet.</p>
                <p style={{ fontSize: 11, fontWeight: 500, color: "var(--fg-subtle)", marginTop: 4 }}>HITL approvals and rejections will appear here.</p>
              </div>
            ) : (
              orchestrations.map((item, i) => (
                <div key={i} onClick={() => router.push("/admin/audit")}
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
        </div>

        {/* Right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

          {/* Quick actions */}
          <div className="reveal reveal-4" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 28, padding: 28 }}>
            <div className="eyebrow" style={{ marginBottom: 18 }}>Quick actions</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { icon: MessageSquare, label: "New chat",          sub: "Ask Athene anything",                    href: "/chat" },
                { icon: Link2,         label: "Manage connectors", sub: `${stats.integrations} active`,           href: "/admin/integrations" },
                { icon: Upload,        label: "Upload files",      sub: `${stats.documents} docs indexed`,        href: "/files" },
              ].map((a) => (
                <button key={a.href} onClick={() => router.push(a.href)}
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
          </div>

          {/* Pipeline status */}
          <div className="reveal reveal-5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 28, padding: 28 }}>
            <div className="eyebrow" style={{ marginBottom: 18 }}>Pipeline status</div>
            {[
              { label: "Document index",  ok: stats.documents > 0,       detail: stats.documents > 0 ? `${stats.documents} docs` : "No docs yet" },
              { label: "Knowledge graph", ok: stats.knowledge_nodes > 0, detail: stats.knowledge_nodes > 0 ? `${stats.knowledge_nodes} entities` : "Empty" },
              { label: "Connectors",      ok: stats.integrations > 0,    detail: stats.integrations > 0 ? `${stats.integrations} connected` : "None active" },
              { label: "BYOK rotation",   ok: false, detail: "Due in 14 days" },
            ].map((r) => (
              <div key={r.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px dashed var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: r.ok ? "#4F7A2E" : "var(--secondary)", flexShrink: 0 }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--fg)" }}>{r.label}</span>
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: r.ok ? "#4F7A2E" : "var(--secondary)" }}>
                  {loading ? "—" : r.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
