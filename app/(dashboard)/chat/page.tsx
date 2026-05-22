"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { Sparkles, Send, Plus, RefreshCw, Database, AlertTriangle, AlertCircle, CheckCircle2, ExternalLink, ArrowRight, Zap, ShieldCheck, Paperclip } from "lucide-react";
import { HitlModal } from "@/components/chat/hitl-modal";
import { toast } from "sonner";

/* ── Design-kit atoms ───────────────────────────────────── */

function IconTile({ icon: I, size = 42, tone = "primary" }: { icon: React.ElementType; size?: number; tone?: "primary" | "amber" | "honey" | "success" | "warn" }) {
  const t = {
    primary: { bg: "rgba(160,74,27,.10)", border: "rgba(160,74,27,.20)", color: "var(--primary)" },
    amber:   { bg: "rgba(217,122,46,.12)", border: "rgba(217,122,46,.22)", color: "var(--secondary)" },
    honey:   { bg: "rgba(230,185,40,.18)", border: "rgba(230,185,40,.32)", color: "#9E780E" },
    success: { bg: "rgba(79,122,46,.12)",  border: "rgba(79,122,46,.25)",  color: "#4F7A2E" },
    warn:    { bg: "rgba(178,58,26,.10)",  border: "rgba(178,58,26,.25)",  color: "var(--danger)" },
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

/* ── Reference cards (right sidebar) ───────────────────── */
const REF_CARDS = [
  { tone: "warn" as const,    icon: AlertTriangle,  title: "Renewal Risk",      body: "3 enterprise accounts have renewals in <30 days with no engagement in the last 14 days.", query: "Which enterprise accounts are at renewal risk this quarter?" },
  { tone: "amber" as const,   icon: Zap,            title: "Pipeline Gap",      body: "Q3 pipeline is 18% below target. Top 2 open deals have had no activity for 9+ days.", query: "Show me stalled deals in the Q3 pipeline." },
  { tone: "success" as const, icon: CheckCircle2,   title: "Connector Health",  body: "All 4 connectors syncing normally. Last full sync completed 47 minutes ago.", query: "What is the current status of all active connectors?" },
  { tone: "primary" as const, icon: Sparkles,       title: "Knowledge Update",  body: "12 new documents indexed since your last session. 3 mention competitor activity.", query: "Summarise competitor mentions from the last 24 hours." },
];

function RefCard({ card, onQuery }: { card: typeof REF_CARDS[0]; onQuery: (q: string) => void }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ borderRadius: 20, padding: "16px 18px", background: "var(--bg-elevated)", border: `1px solid ${hov ? "var(--border-strong)" : "var(--border)"}`, display: "flex", flexDirection: "column", gap: 10, transition: "all .2s var(--ease-out)", boxShadow: hov ? "var(--shadow-2)" : "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <IconTile icon={card.icon} size={32} tone={card.tone} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--fg)" }}>{card.title}</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, fontWeight: 500, color: "var(--fg-muted)" }}>{card.body}</p>
      <button onClick={() => onQuery(card.query)}
        style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 8, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 9, fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-muted)", cursor: "pointer", transition: "all .15s ease" }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--primary)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(160,74,27,.3)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
      >Ask <ArrowRight size={9} /></button>
    </div>
  );
}

/* ── Types ──────────────────────────────────────────────── */
interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  cited_sources?: any[];
  isAnalytical?: boolean;
  awaiting_approval?: boolean;
  isQuotaError?: boolean;
}

/* ── Page ───────────────────────────────────────────────── */
export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([{
    id: "init",
    role: "assistant",
    content: "Hi — I'm Athene. Ask me anything grounded in your connected sources. I'll cite every claim back to its source document.",
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalytical, setIsAnalytical] = useState(false);
  const [threadId, setThreadId] = useState("");
  const [isHitlOpen, setIsHitlOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ tool: string; payload: any } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setThreadId(crypto.randomUUID()); }, []);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function newThread() {
    setThreadId(crypto.randomUUID());
    setMessages([{ id: "init-" + Date.now(), role: "assistant", content: "New session initialized. What would you like to explore?", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
  }

  function sendQuery(q: string) {
    setInput(q);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;

    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content: text, timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    setMessages(p => [...p, userMsg]);
    setInput("");
    setIsLoading(true);

    const assistantId = `a-${Date.now()}`;
    setMessages(p => [...p, { id: assistantId, role: "assistant", content: "", isAnalytical, timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);

    const MAX = 3;
    let attempt = 0, success = false;
    while (attempt <= MAX && !success) {
      if (attempt > 0) {
        setReconnecting(true);
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 8000)));
        setReconnecting(false);
      }
      try {
        const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, threadId, task_type: isAnalytical ? "analytical" : "general" }) });
        if (res.status === 429) { toast.error(`Rate limit reached. Try again in ${res.headers.get("Retry-After") ?? 60}s.`); break; }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n"); buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const p = JSON.parse(line.slice(6));
              if (p.error) {
                const errMsg = p.content || "An error occurred. Please try again.";
                const isQuota = /quota exceeded|quota|rate_limit|billing|BYOK/i.test(errMsg);
                if (isQuota) {
                  toast.error("LLM Quota Exceeded. Please configure a BYOK key in Admin → Keys.", {
                    action: { label: "Admin Keys", onClick: () => window.location.href = "/admin/keys" },
                    duration: 10000,
                  });
                }
                setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: errMsg, isQuotaError: isQuota } : m));
              } else if (p.token) {
                setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content + p.token } : m));
              } else if (p.content || p.cited_sources !== undefined || p.awaiting_approval !== undefined) {
                setMessages(prev => prev.map(m => {
                  if (m.id !== assistantId) return m;
                  return { ...m, content: p.content && p.content.length > m.content.length ? p.content : m.content, cited_sources: p.cited_sources || m.cited_sources, awaiting_approval: p.awaiting_approval ?? m.awaiting_approval };
                }));
                if (p.awaiting_approval && p.pending_write_action) { setPendingAction(p.pending_write_action); setIsHitlOpen(true); }
              }
            } catch { /* skip malformed */ }
          }
        }
        success = true;
      } catch (err) {
        attempt++;
        if (attempt > MAX) {
          toast.error("Connection lost. Please try again.");
          setMessages(prev => prev.map(m => m.id === assistantId && !m.content ? { ...m, content: "⚠ Connection lost. Please try again." } : m));
        }
      }
    }
    setIsLoading(false);
    setReconnecting(false);
  }

  async function handleHitl(action: "approve" | "reject" | "edit", edits?: any) {
    const res = await fetch(`/api/threads/${threadId}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, edits }) });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed"); }
    toast.success(`Action ${action}ed`);
    setPendingAction(null); setIsHitlOpen(false);
    setMessages(p => [...p, { id: `hitl-${Date.now()}`, role: "assistant", content: action === "approve" ? "✓ Action approved — executing in the background." : "✗ Action rejected.", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* Header strip — matches ChatScreen */}
      <div style={{ flexShrink: 0, padding: "20px 40px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 6 }}>Synthesis · cited answers</div>
          <h2 style={{ fontFamily: "var(--font-sans)", fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", textTransform: "uppercase", margin: 0, color: "var(--fg)" }}>Athene Chat</h2>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {reconnecting && <Chip kind="amber">Reconnecting…</Chip>}
          <Chip kind="primary" dot>Live</Chip>
          {/* Mode toggle */}
          <div style={{ display: "flex", background: "var(--bg-muted)", borderRadius: 10, padding: 3, border: "1px solid var(--border)" }}>
            {["Standard", "BI"].map(m => (
              <button key={m} onClick={() => setIsAnalytical(m === "BI")}
                style={{ height: 26, padding: "0 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 9, fontWeight: 800, letterSpacing: "0.25em", textTransform: "uppercase", background: (m === "BI") === isAnalytical ? "var(--bg-elevated)" : "transparent", color: (m === "BI") === isAnalytical ? "var(--primary)" : "var(--fg-muted)", boxShadow: (m === "BI") === isAnalytical ? "var(--shadow-1)" : "none", transition: "all .15s ease", display: "inline-flex", alignItems: "center", gap: 5 }}>
                {m === "BI" && <Database size={9} />}{m}
              </button>
            ))}
          </div>
          <button onClick={newThread} style={{ width: 32, height: 32, borderRadius: 10, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <Plus size={13} />
          </button>
          <Chip kind="outline"><ShieldCheck size={8} style={{ display: "inline", marginRight: 4 }} />Encrypted</Chip>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* Messages + composer */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Messages */}
          <div ref={scrollRef} className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "32px 40px" }}>
            <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>
              {messages.map((msg) => {
                const isA = msg.role === "assistant";
                function renderContent(content: string) {
                  const parts: React.ReactNode[] = [];
                  const re = /\[([a-zA-Z0-9_-]+)\]/g;
                  let last = 0, m;
                  while ((m = re.exec(content)) !== null) {
                    if (m.index > last) parts.push(<span key={`t${last}`}>{content.slice(last, m.index)}</span>);
                    parts.push(<span key={`c${m.index}`} style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px", margin: "0 2px", borderRadius: 6, background: "rgba(217,122,46,.14)", border: "1px solid rgba(217,122,46,.28)", color: "var(--secondary)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700 }}>[{m[1]}]</span>);
                    last = re.lastIndex;
                  }
                  if (last < content.length) parts.push(<span key={`t${last}`}>{content.slice(last)}</span>);
                  return parts;
                }
                return (
                  <div key={msg.id} className="reveal" style={{ display: "flex", justifyContent: isA ? "flex-start" : "flex-end" }}>
                    <div style={{ display: "flex", gap: 14, maxWidth: "82%", flexDirection: isA ? "row" : "row-reverse" }}>
                      {/* Avatar */}
                      <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: isA ? "rgba(160,74,27,.10)" : "var(--primary)", border: isA ? "1px solid rgba(160,74,27,.22)" : "none", color: isA ? "var(--primary)" : "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {isA ? <Sparkles size={18} strokeWidth={1.7} /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>}
                      </div>
                      <div>
                        <div style={{ padding: "16px 22px", borderRadius: 22, fontSize: 14, lineHeight: 1.6, fontWeight: 500, background: isA ? "var(--bg-elevated)" : "var(--primary)", color: isA ? "var(--fg)" : "#fff", border: isA ? "1px solid var(--border)" : "none", boxShadow: "var(--shadow-1)" }}>
                          {isA && msg.isQuotaError ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                                <div style={{ padding: 10, background: "rgba(245,158,11,.1)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 12, flexShrink: 0, color: "#F59E0B" }}>
                                  <AlertCircle size={18} />
                                </div>
                                <div>
                                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.25em", textTransform: "uppercase", color: "#F59E0B", marginBottom: 4 }}>LLM Quota Exceeded</div>
                                  <div style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>{msg.content}</div>
                                </div>
                              </div>
                              <button onClick={() => window.location.href = "/admin/keys"} style={{ alignSelf: "flex-start", padding: "8px 16px", borderRadius: 10, background: "#F59E0B", color: "#000", border: "none", fontSize: 9, fontWeight: 800, letterSpacing: "0.25em", textTransform: "uppercase", cursor: "pointer" }}>
                                Configure BYOK Keys
                              </button>
                            </div>
                          ) : (
                            <>
                              {isA && msg.isAnalytical && (
                                <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><Database size={9} />BI Synthesis</div>
                              )}
                              {msg.content ? renderContent(msg.content) : (
                                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                  <div style={{ display: "flex", gap: 4 }}>
                                    {[0,1,2].map(j => <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--primary)", animation: `dot-bounce 1.2s infinite ${j * 0.18}s` }} />)}
                                  </div>
                                  <span className="eyebrow">Athene is synthesizing…</span>
                                </div>
                              )}
                            </>
                          )}
                          {msg.cited_sources && msg.cited_sources.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16, paddingTop: 14, borderTop: "1px dashed var(--border)" }}>
                              {msg.cited_sources.map((s: any, idx: number) => (
                                <a key={idx} href={s.external_url || "#"} target="_blank" rel="noopener noreferrer"
                                  style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 8, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 9, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--fg-muted)", textDecoration: "none" }}>
                                  <ExternalLink size={9} style={{ color: "var(--primary)" }} />{s.source_type || "Source"}
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Composer — borderRadius 32, padding 10 12 10 18 */}
          <div style={{ flexShrink: 0, padding: "20px 40px 28px" }}>
            <div style={{ maxWidth: 880, margin: "0 auto" }}>
              <form onSubmit={handleSubmit}
                style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 32, padding: "10px 12px 10px 18px", display: "flex", alignItems: "center", gap: 12, boxShadow: "var(--shadow-3)", transition: "border-color .2s ease" }}>
                <button type="button" disabled style={{ width: 38, height: 38, borderRadius: 99, background: "transparent", border: "none", color: "var(--fg-subtle)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "not-allowed", opacity: 0.4 }}>
                  <Paperclip size={18} strokeWidth={1.7} />
                </button>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 180) + "px"; }}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e as any); } }}
                  disabled={isLoading}
                  placeholder={isAnalytical ? "SYNTHESIZE DEPARTMENT-WIDE BI PATTERNS…" : "ASK ATHENE TO SYNTHESIZE ANYTHING…"}
                  rows={1}
                  style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 500, color: "var(--fg)", resize: "none", minHeight: 38, maxHeight: 180, paddingTop: 8, paddingBottom: 8 }}
                />
                <button type="submit" disabled={!input.trim() || isLoading}
                  style={{ width: 44, height: 44, borderRadius: 99, background: input.trim() && !isLoading ? "var(--primary)" : "var(--bg-muted)", color: input.trim() && !isLoading ? "#fff" : "var(--fg-subtle)", border: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", boxShadow: input.trim() && !isLoading ? "0 10px 22px -10px rgba(160,74,27,.55)" : "none", transition: "all .2s var(--ease-out)", cursor: input.trim() && !isLoading ? "pointer" : "not-allowed" }}>
                  {isLoading ? <RefreshCw size={16} style={{ animation: "spin 1s linear infinite" }} /> : <Send size={16} />}
                </button>
              </form>
            </div>
          </div>
        </div>

        {/* Reference sidebar */}
        <aside className="custom-scrollbar" style={{ width: 288, flexShrink: 0, borderLeft: "1px solid var(--border)", overflowY: "auto", padding: "20px 16px 32px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Intelligence · live</div>
          {REF_CARDS.map((card, i) => (
            <div key={i} className={`reveal reveal-${Math.min(i + 2, 6)}`}>
              <RefCard card={card} onQuery={sendQuery} />
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>Quick prompts</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {["Summarise this week's top decisions from Slack", "Which KPIs are trending down vs last quarter?", "Show open Jira blockers for engineering"].map((q, i) => (
                <button key={i} onClick={() => sendQuery(q)}
                  style={{ textAlign: "left", padding: "9px 12px", borderRadius: 10, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 11, fontWeight: 500, color: "var(--fg-muted)", lineHeight: 1.45, cursor: "pointer", transition: "all .15s ease" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
                >{q}</button>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <HitlModal isOpen={isHitlOpen} onClose={() => setIsHitlOpen(false)} threadId={threadId} pendingAction={pendingAction} onDecision={handleHitl} />

      <style>{`
        @keyframes dot-bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
      `}</style>
    </div>
  );
}
