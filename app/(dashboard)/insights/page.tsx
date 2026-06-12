"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { BarChart3, Plus, Sparkles, AlertCircle, X, CheckCircle2, RefreshCw, Trash2, Search, Loader2 } from "lucide-react";
import { useAuth } from "@clerk/nextjs";
import { mapRole } from "@/lib/auth/clerk";
import { Button } from "@/components/ui/button";
import { type Insight } from "@/components/insights/insight-card";
import { IconTile, Chip, TCard } from "@/components/ui/kit";
import { cn } from "@/lib/utils";
import { fetchWithTimeout } from "@/lib/fetch-timeout";

/* ── Add Insight Dialog ─────────────────────────────────── */
function AddDialog({ open, onClose, onSubmit, submitting }: { open: boolean; onClose: () => void; onSubmit: (t: string, q: string) => void; submitting: boolean }) {
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) { setTitle(""); setQuery(""); setTimeout(() => inputRef.current?.focus(), 80); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn); return () => window.removeEventListener("keydown", fn);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", backdropFilter: "blur(8px)" }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--r-xl)", padding: 36, width: "100%", maxWidth: 520, boxShadow: "var(--shadow-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
          <IconTile icon={BarChart3} size={44} tone="primary" />
          <div>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.03em", textTransform: "uppercase", color: "var(--fg)" }}>New Insight Card</div>
            <div className="eyebrow" style={{ marginTop: 4 }}>Save a BI query as a reusable intelligence card</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 24 }}>
          <div>
            <label className="eyebrow" style={{ display: "block", marginBottom: 8 }}>Title</label>
            <input ref={inputRef} value={title} onChange={e => setTitle(e.target.value)} placeholder="Q1 enterprise renewal risk" style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-muted)", color: "var(--fg)", fontSize: 14, fontWeight: 500, outline: "none", fontFamily: "var(--font-sans)", boxSizing: "border-box" }} />
          </div>
          <div>
            <label className="eyebrow" style={{ display: "block", marginBottom: 8 }}>Query</label>
            <textarea value={query} onChange={e => setQuery(e.target.value)} placeholder="Which enterprise accounts are at renewal risk this quarter?" rows={3} style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: "1px solid var(--border)", background: "var(--bg-muted)", color: "var(--fg)", fontSize: 14, fontWeight: 500, outline: "none", fontFamily: "var(--font-sans)", resize: "vertical", boxSizing: "border-box" }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ height: 44, padding: "0 20px", borderRadius: 12, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", fontSize: 11, fontWeight: 800, letterSpacing: "0.2em", textTransform: "uppercase", cursor: "pointer" }}>Cancel</button>
          <button onClick={() => title.trim() && query.trim() && onSubmit(title.trim(), query.trim())} disabled={!title.trim() || !query.trim() || submitting}
            style={{ height: 44, padding: "0 24px", borderRadius: 12, background: "var(--primary)", border: "none", color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: "0.2em", textTransform: "uppercase", cursor: "pointer", boxShadow: "0 10px 24px -10px rgba(160,74,27,.55)", display: "inline-flex", alignItems: "center", gap: 8 }}>
            {submitting ? "Saving…" : <><Sparkles size={14} /> Save card</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Insight card ───────────────────────────────────────── */
function InsightCard({ card, idx, onRefresh, onDelete, confirmDeleteId, setConfirmDeleteId }: {
  card: Insight; idx: number; onRefresh: (id: string) => void; onDelete: (id: string) => void;
  confirmDeleteId: string | null; setConfirmDeleteId: (id: string | null) => void;
}) {
  const [hov, setHov] = useState(false);
  const tone = idx % 2 === 0 ? "primary" : "amber";
  const age = card.refreshed_at ?? card.created_at;
  const ageStr = age ? new Date(age).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ position: "relative", borderRadius: "var(--r-xl)", padding: 26, background: "var(--bg-elevated)", border: `1px solid ${hov ? "var(--border-strong)" : "var(--border)"}`, display: "flex", flexDirection: "column", gap: 16, transition: "all .25s var(--ease-out)", boxShadow: hov ? "var(--shadow-3)" : "none" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <IconTile icon={BarChart3} size={42} tone={tone as any} />
          <div>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--fg)" }}>{card.title}</h3>
            <div className="eyebrow" style={{ marginTop: 4 }}>Intelligence card</div>
          </div>
        </div>
        <Chip kind="outline">{card.result?.citations?.length ?? 0} sources</Chip>
      </div>

      {/* Answer */}
      <div>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Answer</div>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, fontWeight: 500, color: "var(--fg)" }}>
          {card.result?.answer || <span style={{ color: "var(--fg-muted)", fontStyle: "italic" }}>Not yet synthesized — refresh to generate.</span>}
        </p>
      </div>

      {/* Query */}
      <div style={{ padding: 14, background: "var(--bg-muted)", borderRadius: "var(--r-md)", border: "1px solid var(--border)" }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>Query</div>
        <div style={{ fontSize: 12, color: "var(--fg-muted)", fontWeight: 500 }}>{card.query}</div>
      </div>

      {/* Footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: "1px dashed var(--border)" }}>
        <span className="eyebrow">{ageStr}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onRefresh(card.id)} title="Refresh" style={{ width: 30, height: 30, borderRadius: 12, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <RefreshCw size={13} />
          </button>
          <button onClick={() => { if (confirmDeleteId === card.id) onDelete(card.id); else setConfirmDeleteId(card.id); }}
            title={confirmDeleteId === card.id ? "Confirm delete" : "Delete"}
            style={{ width: 30, height: 30, borderRadius: 12, background: confirmDeleteId === card.id ? "rgba(178,58,26,.15)" : "var(--bg-muted)", border: `1px solid ${confirmDeleteId === card.id ? "rgba(178,58,26,.3)" : "var(--border)"}`, color: confirmDeleteId === card.id ? "var(--danger)" : "var(--fg-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Toast ──────────────────────────────────────────────── */
function Toast({ msg, type, onClose }: { msg: string; type: "success" | "error"; onClose: () => void }) {
  const ok = type === "success";
  return (
    <div style={{ position: "fixed", bottom: 40, right: 40, zIndex: 100, display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderRadius: "var(--r-md)", border: `1px solid ${ok ? "rgba(79,122,46,.3)" : "rgba(178,58,26,.3)"}`, background: ok ? "rgba(79,122,46,.12)" : "rgba(178,58,26,.10)", color: ok ? "#4F7A2E" : "var(--danger)", boxShadow: "var(--shadow-4)" }}>
      {ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
      <span style={{ fontSize: 13, fontWeight: 700 }}>{msg}</span>
      <button onClick={onClose} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "inherit", opacity: 0.5 }}><X size={14} /></button>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────── */
export default function InsightsPage() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const showToast = (msg: string, type: "success" | "error") => { setToast({ msg, type }); setTimeout(() => setToast(null), 4000); };

  const fetchInsights = useCallback(async () => {
    try {
      const res = await fetchWithTimeout("/api/insights");
      if (res.status === 401 || res.status === 403) {
        setError("You don't have permission to view BI Insights.");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInsights(await res.json());
      setError(null);
    } catch { setError("Failed to load insights."); } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchInsights(); }, [fetchInsights]);

  const handleAdd = async (title: string, query: string) => {
    setSubmitting(true);
    try {
      const res = await fetchWithTimeout("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, query }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const newCard: Insight = await res.json();
      setInsights((prev) => [newCard, ...prev]);
      setShowAdd(false);
      showToast("Insight card saved.", "success");
    } catch (e: any) { showToast(`Failed to save: ${e.message}`, "error"); } finally { setSubmitting(false); }
  };

  const handleRefresh = async (id: string) => {
    try {
      const res = await fetchWithTimeout("/api/insights", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, refresh: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json();
      setInsights(prev => prev.map(c => c.id === id ? updated : c));
      showToast("Card refreshed.", "success");
    } catch (e: any) { showToast(`Refresh failed: ${e.message}`, "error"); }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetchWithTimeout(`/api/insights?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInsights(prev => prev.filter(c => c.id !== id));
      showToast("Card removed.", "success");
      setConfirmDeleteId(null);
    } catch (e: any) { showToast(`Delete failed: ${e.message}`, "error"); }
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "36px 40px 80px" }}>

      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
      <AddDialog open={showAdd} onClose={() => setShowAdd(false)} onSubmit={handleAdd} submitting={submitting} />

      {/* Header */}
      <TCard i={0} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 32, flexWrap: "wrap", gap: 20 }}>
        <div>
          <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 8 }}>BI · cross-departmental</div>
          <h1 style={{ fontFamily: "var(--font-sans)", fontSize: 44, fontWeight: 800, letterSpacing: "-0.04em", textTransform: "uppercase", margin: 0, color: "var(--fg)" }}>Insights</h1>
          <p style={{ color: "var(--fg-muted)", fontSize: 15, fontWeight: 500, marginTop: 8, maxWidth: 540 }}>
            Saved intelligence cards with synthesized answers from your connected knowledge sources.
          </p>
        </div>
        {/* Lavender disruptor — generative action */}
        <button onClick={() => setShowAdd(true)} className="btn-lav"
          style={{ height: 42, padding: "0 20px", borderRadius: 12, fontSize: 11, fontWeight: 800, letterSpacing: "0.2em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", boxShadow: "0 10px 24px -10px rgba(124,91,166,.5)" }}>
          <Plus size={14} /> New insight
        </button>
      </TCard>

      {/* Error */}
      {error && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderRadius: "var(--r-md)", background: "rgba(178,58,26,.10)", border: "1px solid rgba(178,58,26,.25)", color: "var(--danger)", marginBottom: 24 }}>
          <AlertCircle size={16} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>{error}</span>
          <button onClick={fetchInsights} style={{ marginLeft: "auto", fontSize: 11, fontWeight: 800, background: "none", border: "none", color: "var(--danger)", cursor: "pointer", letterSpacing: "0.2em", textTransform: "uppercase" }}>Retry</button>
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 18 }}>
          {[...Array(4)].map((_, i) => <div key={i} style={{ height: 280, borderRadius: "var(--r-xl)", background: "var(--bg-muted)", opacity: 0.4 }} />)}
        </div>
      ) : insights.length === 0 ? (
        <div style={{ padding: "64px 40px", textAlign: "center", border: "1px dashed var(--border-strong)", borderRadius: "var(--r-2xl)", background: "var(--bg-elevated)" }}>
          <IconTile icon={Sparkles} size={80} tone="primary" />
          <h3 style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-0.04em", textTransform: "uppercase", marginTop: 24, color: "var(--fg)" }}>No insight cards yet</h3>
          <p style={{ color: "var(--fg-muted)", fontSize: 15, fontWeight: 500, maxWidth: 380, margin: "14px auto 28px" }}>Save a BI query and Athene will synthesize an answer from your connected sources.</p>
          <button onClick={() => setShowAdd(true)}
            style={{ height: 52, padding: "0 28px", borderRadius: "var(--r-md)", background: "var(--primary)", border: "none", color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: "0.28em", textTransform: "uppercase", display: "inline-flex", alignItems: "center", gap: 10, cursor: "pointer", boxShadow: "0 14px 30px -10px rgba(160,74,27,.55)" }}>
            <Sparkles size={14} /> Create first card
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 18 }}>
          {insights.map((card, i) => (
            <TCard key={card.id} i={i + 1}>
              <InsightCard card={card} idx={i} onRefresh={handleRefresh} onDelete={handleDelete} confirmDeleteId={confirmDeleteId} setConfirmDeleteId={setConfirmDeleteId} />
            </TCard>
          ))}
        </div>
      )}
    </div>
  );
}
