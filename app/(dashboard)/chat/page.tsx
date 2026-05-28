"use client";

import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Send, Plus, RefreshCw, Database, AlertTriangle, AlertCircle, CheckCircle2, ExternalLink, ArrowRight, Zap, ShieldCheck, Share2 } from "lucide-react";
import { IconTile, Chip, TCard } from "@/components/ui/kit";
import { Composer } from "@/components/chat/composer";
import { HitlModal } from "@/components/chat/hitl-modal";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { toast } from "sonner";

/* ── Reference cards (right sidebar) ───────────────────── */
const CARD_ICONS: Record<string, React.ElementType> = {
  connector_health: CheckCircle2,
  knowledge_update: Sparkles,
  renewal_risk:     AlertTriangle,
  pipeline_gap:     Zap,
};

interface IntelCard { id: string; tone: string; title: string; body: string; query: string; }

function RefCard({ card, onQuery }: { card: IntelCard; onQuery: (q: string) => void }) {
  const IconComponent = CARD_ICONS[card.id] ?? Sparkles;
  const cardWithIcon = { ...card, icon: IconComponent, tone: card.tone as any };
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ borderRadius: 20, padding: "16px 18px", background: "var(--bg-elevated)", border: `1px solid ${hov ? "var(--border-strong)" : "var(--border)"}`, display: "flex", flexDirection: "column", gap: 10, transition: "all .2s var(--ease-out)", boxShadow: hov ? "var(--shadow-2)" : "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <IconTile icon={cardWithIcon.icon} size={32} tone={cardWithIcon.tone} />
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
const AGENT_LABELS: Record<string, string> = {
  planner: "Planning",
  retrieval: "Searching sources",
  cross_dept_retrieval: "Cross-dept search",
  email_agent: "Drafting email",
  calendar_agent: "Checking calendar",
  integration_agent: "Checking integrations",
  action_executor: "Executing action",
  report_agent: "Writing report",
  synthesis: "Synthesizing answer",
};

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  cited_sources?: any[];
  isAnalytical?: boolean;
  awaiting_approval?: boolean;
  isQuotaError?: boolean;
  steps?: string[];
}

/* ── Page ───────────────────────────────────────────────── */
export default function ChatPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([{
    id: "init",
    role: "assistant",
    content: "Hi — I'm Athene. Ask me anything across your connected sources and I'll cite every answer back to its origin.",
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }]);
  // prefill.seq increments on every sendQuery call so the Composer effect
  // always fires even when the same query string is clicked twice.
  const [prefill, setPrefill] = useState<{ value: string; seq: number }>({ value: "", seq: 0 });
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalytical, setIsAnalytical] = useState(false);
  const [threadId, setThreadId] = useState("");
  const [isHitlOpen, setIsHitlOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ tool: string; payload: any } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [intelCards, setIntelCards] = useState<IntelCard[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setThreadId(crypto.randomUUID()); }, []);
  useEffect(() => {
    fetch("/api/intelligence")
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.cards) setIntelCards(d.cards); })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function newThread() {
    setThreadId(crypto.randomUUID());
    setMessages([{ id: "init-" + Date.now(), role: "assistant", content: "New session started. What would you like to explore?", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
  }

  function sendQuery(q: string) {
    setPrefill(prev => ({ value: q, seq: prev.seq + 1 }));
  }

  async function handleSend(message: string, scope?: string) {
    const text = message.trim();
    if (!text || isLoading) return;
    // pass scope through to the stream payload (ignored if "All sources")
    return handleSubmit(null, text, scope);
  }

  async function handleSubmit(e: FormEvent | null, overrideText?: string, scope?: string) {
    if (e) e.preventDefault();
    const text = overrideText?.trim() ?? "";
    if (!text || isLoading) return;

    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content: text, timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    setMessages(p => [...p, userMsg]);
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
        const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, threadId, task_type: isAnalytical ? "analytical" : "general", ...(scope && scope !== "All sources" ? { scope } : {}) }) });
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
              } else if (p.active_agent) {
                const label = AGENT_LABELS[p.active_agent] ?? p.active_agent;
                setMessages(prev => prev.map(m => {
                  if (m.id !== assistantId) return m;
                  const steps = m.steps ?? [];
                  if (steps[steps.length - 1] === label) return m;
                  return { ...m, steps: [...steps, label] };
                }));
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
          <button
            onClick={() => { newThread(); router.push("/chat"); }}
            title="⌘K · New thread"
            style={{ width: 32, height: 32, borderRadius: 10, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <Plus size={13} />
          </button>
          <button
            onClick={() => { navigator.clipboard.writeText(window.location.href); toast.success("Thread URL copied"); }}
            title="⊕ Share"
            style={{ width: 32, height: 32, borderRadius: 10, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <Share2 size={13} />
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
              {/* Suggested prompts — only shown when no user message has been sent yet */}
              {messages.length === 1 && messages[0].role === "assistant" && (
                <div className="reveal" style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", padding: "8px 0 4px" }}>
                  {[
                    "What happened this week across my tools?",
                    "Summarise open engineering blockers",
                    "Show recent activity in my pipeline",
                    "What decisions were made last sprint?",
                  ].map((q) => (
                    <button key={q} onClick={() => sendQuery(q)}
                      style={{ padding: "8px 16px", borderRadius: 999, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 11, fontWeight: 600, color: "var(--fg-muted)", cursor: "pointer", lineHeight: 1.4, transition: "all .15s ease" }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--primary)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(160,74,27,.35)"; (e.currentTarget as HTMLElement).style.background = "rgba(160,74,27,.06)"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; (e.currentTarget as HTMLElement).style.background = "var(--bg-muted)"; }}
                    >{q}</button>
                  ))}
                </div>
              )}

              {messages.map((msg) => {
                const isA = msg.role === "assistant";
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
                              {isA && msg.steps && msg.steps.length > 0 && (
                                <div style={{ marginBottom: 12 }}>
                                  {/* Active step — large animated pill while no content yet */}
                                  {!msg.content && (
                                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px", borderRadius: 999, background: "rgba(160,74,27,0.12)", border: "1px solid rgba(160,74,27,0.30)", marginBottom: 10 }}>
                                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--primary)", display: "inline-block", animation: "dot-bounce 1.2s infinite", flexShrink: 0 }} />
                                      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--primary)" }}>
                                        {msg.steps[msg.steps.length - 1]}
                                      </span>
                                    </div>
                                  )}
                                  {/* Past steps — compact muted badges */}
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                    {(msg.content ? msg.steps : msg.steps.slice(0, -1)).map((step, si) => (
                                      <span key={si} style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 6, background: "rgba(160,74,27,0.06)", border: "1px solid rgba(160,74,27,0.12)", fontSize: 9, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "rgba(245,237,216,0.35)" }}>
                                        {step}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {isA && msg.isAnalytical && (
                                <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}><Database size={9} />BI Synthesis</div>
                              )}
                              {msg.content ? <MarkdownMessage content={msg.content} /> : (
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
                              {/* Deduplicate by document_id before rendering */}
                              {Array.from(new Map(msg.cited_sources.map((s: any) => [s.document_id, s])).values()).map((s: any, idx: number) => {
                                const label = s.title || s.source_type || "Source";
                                const displayLabel = label.length > 32 ? label.slice(0, 32) + "…" : label;
                                return s.external_url ? (
                                  <a key={idx} href={s.external_url} target="_blank" rel="noopener noreferrer"
                                    title={label}
                                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: 8, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 10, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--fg-muted)", textDecoration: "none", transition: "all .15s ease" }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--primary)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(160,74,27,.3)"; }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
                                  >
                                    <ExternalLink size={9} style={{ color: "var(--primary)", flexShrink: 0 }} />
                                    {displayLabel}
                                  </a>
                                ) : (
                                  <span key={idx} title={label}
                                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: 8, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 10, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--fg-muted)" }}>
                                    <ExternalLink size={9} style={{ color: "var(--primary)", flexShrink: 0 }} />
                                    {displayLabel}
                                  </span>
                                );
                              })}
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

          {/* Composer — shared component with scope chips, char counter, error state */}
          <Composer
            onSend={handleSend}
            isLoading={isLoading}
            isAnalytical={isAnalytical}
            placeholder={isAnalytical ? "SYNTHESIZE DEPARTMENT-WIDE BI PATTERNS…" : "ASK ATHENE TO SYNTHESIZE ANYTHING…"}
            prefillValue={prefill.value}
            prefillSeq={prefill.seq}
          />
        </div>

        {/* Reference sidebar — hidden below lg breakpoint to avoid overflow on small screens */}
        <aside className="custom-scrollbar hidden lg:flex" style={{ width: 288, flexShrink: 0, borderLeft: "1px solid var(--border)", overflowY: "auto", padding: "20px 16px 32px", flexDirection: "column", gap: 12 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Intelligence · live</div>
          {intelCards.map((card, i) => (
            <TCard key={card.id} i={i + 1}>
              <RefCard card={card} onQuery={sendQuery} />
            </TCard>
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
