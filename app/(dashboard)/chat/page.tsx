"use client";

import React, { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Sparkles, Plus, Database, AlertTriangle, AlertCircle, CheckCircle2,
  ExternalLink, ArrowRight, Zap, ShieldCheck, Share2,
  MessageSquare, ChevronLeft, ChevronRight, Trash2,
} from "lucide-react";
import { IconTile, Chip, TCard } from "@/components/ui/kit";
import { Composer } from "@/components/chat/composer";
import { HitlModal } from "@/components/chat/hitl-modal";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Thread {
  id: string;
  title: string | null;
  last_message_at: string | null;
  message_count: number;
  created_at: string;
}

/** Message from the LangGraph state checkpoint (via /api/agent/status) */
interface LGMessage {
  type: string;
  content: string | unknown[];
  id?: string;
}

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

interface IntelCard { id: string; tone: string; title: string; body: string; query: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_LABELS: Record<string, string> = {
  planner:               "Planning",
  retrieval:             "Searching sources",
  cross_dept_retrieval:  "Cross-dept search",
  email_agent:           "Drafting email",
  calendar_agent:        "Checking calendar",
  integration_agent:     "Checking integrations",
  action_executor:       "Executing action",
  report_agent:          "Writing report",
  synthesis:             "Synthesizing answer",
};

const CARD_ICONS: Record<string, React.ElementType> = {
  connector_health: CheckCircle2,
  knowledge_update: Sparkles,
  renewal_risk:     AlertTriangle,
  pipeline_gap:     Zap,
};

const THREAD_ID_KEY = "athene:threadId";

// Internal agent messages that should not appear in restored conversation history.
const ROUTING_PREFIXES = [
  "[Retrieval complete]",
  "[Guard]",
  "[Planner]",
  "[Plan step",
  "[cross-dept",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function welcomeMsg(id = "init"): Message {
  return {
    id,
    role: "assistant",
    content: "Hi — I'm Athene. Ask me anything across your connected sources and I'll cite every answer back to its origin.",
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Converts LangGraph checkpoint messages to display Messages.
 *
 * Filters:
 *   - tool messages (ToolMessage) — internal plumbing, not user-visible
 *   - routing AI messages that start with known internal prefixes
 *   - empty content
 *   - very short (<10 char) AI messages (routing artifacts)
 */
function reconstructMessages(lgMsgs: LGMessage[]): Message[] {
  const result: Message[] = [];
  for (const m of lgMsgs) {
    const text =
      typeof m.content === "string"
        ? m.content.trim()
        : Array.isArray(m.content)
          ? (m.content as any[]).map(c => (typeof c === "string" ? c : c?.text ?? "")).join("").trim()
          : "";
    if (!text) continue;

    if (m.type === "human") {
      result.push({ id: m.id ?? crypto.randomUUID(), role: "user", content: text, timestamp: "" });
    } else if (m.type === "ai" || m.type === "AIMessageChunk") {
      if (ROUTING_PREFIXES.some(p => text.startsWith(p))) continue;
      if (text.length < 10) continue;
      result.push({ id: m.id ?? crypto.randomUUID(), role: "assistant", content: text, timestamp: "" });
    }
    // ToolMessage and other internal types are skipped
  }
  return result;
}

// ─── ThreadItem ───────────────────────────────────────────────────────────────

function ThreadItem({
  thread, isActive, onSelect, onDelete,
}: {
  thread: Thread;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [hov, setHov] = useState(false);
  const raw = thread.title ?? "Untitled thread";
  const title = raw.length > 30 ? raw.slice(0, 30) + "…" : raw;

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={onSelect}
      style={{
        position: "relative",
        padding: "9px 8px",
        borderRadius: 10,
        marginBottom: 2,
        cursor: "pointer",
        background: isActive
          ? "rgba(160,74,27,.12)"
          : hov ? "var(--bg-muted)" : "transparent",
        border: `1px solid ${isActive ? "rgba(160,74,27,.25)" : hov ? "var(--border)" : "transparent"}`,
        transition: "all .15s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
        <MessageSquare
          size={11}
          style={{ color: isActive ? "var(--primary)" : "var(--fg-muted)", marginTop: 2, flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: isActive ? "var(--primary)" : "var(--fg)", lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
            <span style={{ fontSize: 9, color: "var(--fg-muted)", fontWeight: 500 }}>
              {relativeTime(thread.last_message_at ?? thread.created_at)}
            </span>
            {thread.message_count > 0 && (
              <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, background: "var(--bg-muted)", color: "var(--fg-muted)", fontWeight: 600 }}>
                {thread.message_count}
              </span>
            )}
          </div>
        </div>
        {/* Delete — visible on hover only */}
        {hov && (
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            title="Delete thread"
            style={{ width: 20, height: 20, borderRadius: 5, border: "none", background: "transparent", color: "var(--fg-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "#ef4444"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; }}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── RefCard ──────────────────────────────────────────────────────────────────

function RefCard({ card, onQuery }: { card: IntelCard; onQuery: (q: string) => void }) {
  const IconComponent = CARD_ICONS[card.id] ?? Sparkles;
  const [hov, setHov] = useState(false);
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ borderRadius: 20, padding: "16px 18px", background: "var(--bg-elevated)", border: `1px solid ${hov ? "var(--border-strong)" : "var(--border)"}`, display: "flex", flexDirection: "column", gap: 10, transition: "all .2s var(--ease-out)", boxShadow: hov ? "var(--shadow-2)" : "none" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <IconTile icon={IconComponent} size={32} tone={card.tone as any} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--fg)" }}>{card.title}</span>
      </div>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, fontWeight: 500, color: "var(--fg-muted)" }}>{card.body}</p>
      <button
        onClick={() => onQuery(card.query)}
        style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 8, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 9, fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-muted)", cursor: "pointer", transition: "all .15s ease" }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--primary)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(160,74,27,.3)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
      >Ask <ArrowRight size={9} /></button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ChatPage() {
  // ── Conversation ──────────────────────────────────────
  const [messages, setMessages]       = useState<Message[]>([welcomeMsg()]);
  const [prefill, setPrefill]         = useState<{ value: string; seq: number }>({ value: "", seq: 0 });
  const [isLoading, setIsLoading]     = useState(false);
  const [isAnalytical, setIsAnalytical] = useState(false);
  const [threadId, setThreadId]       = useState<string>("");
  const [isHitlOpen, setIsHitlOpen]   = useState(false);
  const [pendingAction, setPendingAction] = useState<{ tool: string; payload: any } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [intelCards, setIntelCards]   = useState<IntelCard[]>([]);
  const [noConnections, setNoConnections] = useState(false);

  // ── Thread history ────────────────────────────────────
  const [threads, setThreads]               = useState<Thread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [showThreadSidebar, setShowSidebar] = useState(true);
  const [restoringThread, setRestoringThread] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Load thread list ───────────────────────────────────
  const loadThreadList = useCallback(async () => {
    setThreadsLoading(true);
    try {
      const res = await fetch("/api/threads");
      if (res.ok) {
        const data = await res.json();
        setThreads(data.threads ?? []);
      }
    } catch { /* non-critical — sidebar just stays empty */ }
    finally { setThreadsLoading(false); }
  }, []);

  // ── Restore thread from LangGraph checkpoint ───────────
  // Uses GET /api/agent/status which reads the persisted graph state.
  // Reconstructs the human↔AI message pairs from checkpoint messages,
  // filtering internal routing/tool messages that users should never see.
  const loadThread = useCallback(async (id: string) => {
    setRestoringThread(true);
    try {
      const res = await fetch(`/api/agent/status?threadId=${encodeURIComponent(id)}`);
      if (!res.ok) { setMessages([welcomeMsg(`init-${Date.now()}`)]); return; }

      const data = await res.json();
      const lgMsgs = data.values?.messages as LGMessage[] | undefined;

      if (lgMsgs && lgMsgs.length > 0) {
        const restored = reconstructMessages(lgMsgs);
        if (restored.length > 0) { setMessages(restored); return; }
      }
      // Thread in DB but no LangGraph state yet (no messages sent) — show welcome
      setMessages([welcomeMsg(`init-${Date.now()}`)]);
    } catch {
      setMessages([welcomeMsg(`init-${Date.now()}`)]);
    } finally {
      setRestoringThread(false);
    }
  }, []);

  // ── Init: restore last active thread from localStorage ─
  useEffect(() => {
    const stored = localStorage.getItem(THREAD_ID_KEY);
    if (stored) {
      setThreadId(stored);
      loadThread(stored);
    } else {
      const newId = crypto.randomUUID();
      setThreadId(newId);
      localStorage.setItem(THREAD_ID_KEY, newId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadThreadList(); }, [loadThreadList]);

  useEffect(() => {
    fetch("/api/intelligence")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.cards) { setIntelCards(d.cards); setNoConnections(d.cards.length === 0); }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // ── Thread management ──────────────────────────────────

  /** Switch to a previous thread and restore its conversation. */
  function switchToThread(id: string) {
    if (id === threadId) return;
    setThreadId(id);
    localStorage.setItem(THREAD_ID_KEY, id);
    loadThread(id);
  }

  /** Create a blank new thread (UUID + localStorage) and clear the view. */
  function newThread() {
    const newId = crypto.randomUUID();
    setThreadId(newId);
    localStorage.setItem(THREAD_ID_KEY, newId);
    setMessages([{
      id: "init-" + Date.now(),
      role: "assistant",
      content: "New session started. What would you like to explore?",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }]);
    // Refresh thread list after the first message creates the thread in the DB.
    setTimeout(loadThreadList, 2000);
  }

  /** Delete a thread from the DB and remove it from the sidebar. */
  async function deleteThread(id: string) {
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        setThreads(prev => prev.filter(t => t.id !== id));
        if (id === threadId) newThread();
      } else {
        toast.error("Failed to delete thread");
      }
    } catch { toast.error("Failed to delete thread"); }
  }

  // ── Query helpers ──────────────────────────────────────

  function sendQuery(q: string) {
    setPrefill(prev => ({ value: q, seq: prev.seq + 1 }));
  }

  async function handleSend(message: string, scope?: string) {
    if (!message.trim() || isLoading) return;
    return handleSubmit(null, message.trim(), scope);
  }

  // ── Main submit — SSE stream with robust reconnect ────
  //
  // Reconnect strategy:
  //   1. On stream close with no content: check /api/agent/status before
  //      retrying POST. If the agent already finished (stream just dropped),
  //      restore from state instead of re-sending the message (which would
  //      inject a duplicate HumanMessage into the LangGraph checkpoint).
  //   2. On fetch/read throw (network error, Vercel timeout): same — check
  //      status endpoint first. Only retry POST if status shows the agent
  //      never received the message.
  //   3. Back-off: 1 s → 2 s → 4 s (capped at 8 s), max 3 retries.
  async function handleSubmit(e: FormEvent | null, overrideText?: string, scope?: string) {
    if (e) e.preventDefault();
    const text = overrideText?.trim() ?? "";
    if (!text || isLoading) return;

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages(p => [...p, userMsg]);
    setIsLoading(true);

    const assistantId = `a-${Date.now()}`;
    setMessages(p => [...p, {
      id: assistantId,
      role: "assistant",
      content: "",
      isAnalytical,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }]);

    const MAX_RETRIES = 3;
    let attempt = 0;
    let success = false;
    // threadId is stable in this closure (doesn't change during a single submit)
    const activeThreadId = threadId;

    while (attempt <= MAX_RETRIES && !success) {
      if (attempt > 0) {
        setReconnecting(true);
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 8000)));
        setReconnecting(false);
      }

      // Tracks tokens/content received in this attempt — used to decide whether
      // to check the status endpoint vs. retry POST on unexpected stream close.
      let accumulated = "";

      // Helper: check status endpoint and restore final answer if agent finished.
      // Returns true if the agent had already completed and the message was restored.
      async function tryStatusRecovery(): Promise<boolean> {
        try {
          const sr = await fetch(`/api/agent/status?threadId=${encodeURIComponent(activeThreadId)}`);
          if (!sr.ok) return false;
          const sd = await sr.json();
          const fa = sd.values?.final_answer as string | null | undefined;
          if (fa && (sd.status === "completed" || sd.status === "done")) {
            setMessages(prev => prev.map(m =>
              m.id === assistantId
                ? { ...m, content: fa, cited_sources: sd.values?.cited_sources ?? [] }
                : m
            ));
            setTimeout(loadThreadList, 500);
            return true;
          }
        } catch { /* ignore */ }
        return false;
      }

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            threadId: activeThreadId,
            task_type: isAnalytical ? "analytical" : "general",
            ...(scope && scope !== "All sources" ? { scope } : {}),
          }),
        });

        if (res.status === 429) {
          toast.error(`Rate limit reached. Try again in ${res.headers.get("Retry-After") ?? 60}s.`);
          break;
        }
        if (res.status === 409) {
          // Thread awaiting HITL approval — send message telling user to act first
          const errData = await res.json().catch(() => ({}));
          toast.error(errData.error ?? "An action is awaiting your approval before sending more messages.");
          setMessages(prev => prev.filter(m => m.id !== assistantId));
          break;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const dec    = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const p = JSON.parse(line.slice(6));

              if (p.error) {
                const errMsg = p.content || "An error occurred. Please try again.";
                const isQuota = /quota exceeded|quota|rate_limit|billing|BYOK/i.test(errMsg);
                if (isQuota) {
                  toast.error("LLM Quota Exceeded. Configure a BYOK key in Admin → Keys.", {
                    action: { label: "Admin Keys", onClick: () => { window.location.href = "/admin/keys"; } },
                    duration: 10000,
                  });
                }
                accumulated = errMsg;
                setMessages(prev => prev.map(m =>
                  m.id === assistantId ? { ...m, content: errMsg, isQuotaError: isQuota } : m
                ));

              } else if (p.token) {
                accumulated += p.token;
                setMessages(prev => prev.map(m =>
                  m.id === assistantId ? { ...m, content: m.content + p.token } : m
                ));

              } else if (p.active_agent) {
                const label = AGENT_LABELS[p.active_agent] ?? p.active_agent;
                setMessages(prev => prev.map(m => {
                  if (m.id !== assistantId) return m;
                  const steps = m.steps ?? [];
                  if (steps[steps.length - 1] === label) return m;
                  return { ...m, steps: [...steps, label] };
                }));

              } else if (p.content !== undefined || p.cited_sources !== undefined || p.awaiting_approval !== undefined) {
                if (p.content) accumulated = accumulated || p.content;
                setMessages(prev => prev.map(m => {
                  if (m.id !== assistantId) return m;
                  return {
                    ...m,
                    content: p.content && p.content.length > m.content.length ? p.content : m.content,
                    cited_sources: p.cited_sources || m.cited_sources,
                    awaiting_approval: p.awaiting_approval ?? m.awaiting_approval,
                  };
                }));
                if (p.awaiting_approval && p.pending_write_action) {
                  setPendingAction(p.pending_write_action);
                  setIsHitlOpen(true);
                }
              }
            } catch { /* skip malformed SSE frame */ }
          }
        }

        // Stream closed cleanly (done: true).
        if (accumulated) {
          // We received content — success.
          success = true;
          setTimeout(loadThreadList, 500);
        } else {
          // Stream ended with no content — Vercel 30 s timeout may have cut the
          // connection before the agent finished writing tokens. Check the state
          // checkpoint before retrying POST to avoid a duplicate HumanMessage.
          const recovered = await tryStatusRecovery();
          if (recovered) {
            success = true;
          } else {
            // Agent hasn't finished or state is empty — safe to retry POST.
            attempt++;
            if (attempt > MAX_RETRIES) {
              toast.error("Connection lost. Please try again.");
              setMessages(prev => prev.map(m =>
                m.id === assistantId && !m.content ? { ...m, content: "⚠ Connection lost. Please try again." } : m
              ));
            }
          }
        }

      } catch (err) {
        // fetch() threw or reader.read() threw (network drop, timeout).
        // The agent route may have already processed the message and saved state —
        // check status first to avoid sending the message a second time.
        const recovered = await tryStatusRecovery();
        if (recovered) {
          success = true;
        } else {
          attempt++;
          if (attempt > MAX_RETRIES) {
            toast.error("Connection lost. Please try again.");
            setMessages(prev => prev.map(m =>
              m.id === assistantId && !m.content ? { ...m, content: "⚠ Connection lost. Please try again." } : m
            ));
          }
        }
      }
    }

    setIsLoading(false);
    setReconnecting(false);
  }

  async function handleHitl(action: "approve" | "reject" | "edit", edits?: any) {
    const res = await fetch(`/api/threads/${threadId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, edits }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed"); }
    const isRejected = action === "reject";
    toast[isRejected ? "error" : "success"](
      isRejected ? "Action rejected" : action === "edit" ? "Changes saved — executing" : "Action approved"
    );
    setPendingAction(null);
    setIsHitlOpen(false);
    setMessages(p => [...p, {
      id: `hitl-${Date.now()}`,
      role: "assistant",
      content: isRejected ? "✗ Action rejected." : "✓ Action approved — executing in the background.",
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    }]);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const showSuggestedPrompts =
    !restoringThread &&
    messages.length === 1 &&
    messages[0].role === "assistant" &&
    !noConnections;

  const showNoConnections =
    !restoringThread &&
    messages.length === 1 &&
    noConnections;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, padding: "20px 40px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 6 }}>Synthesis · cited answers</div>
          <h2 style={{ fontFamily: "var(--font-sans)", fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", textTransform: "uppercase", margin: 0, color: "var(--fg)" }}>Athene Chat</h2>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {reconnecting && <Chip kind="amber">Reconnecting…</Chip>}
          <Chip kind="primary" dot>Live</Chip>
          {/* BI / Standard mode toggle */}
          <div style={{ display: "flex", background: "var(--bg-muted)", borderRadius: 10, padding: 3, border: "1px solid var(--border)" }}>
            {(["Standard", "BI"] as const).map(m => (
              <button key={m} onClick={() => setIsAnalytical(m === "BI")}
                style={{ height: 26, padding: "0 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 9, fontWeight: 800, letterSpacing: "0.25em", textTransform: "uppercase", background: (m === "BI") === isAnalytical ? "var(--bg-elevated)" : "transparent", color: (m === "BI") === isAnalytical ? "var(--primary)" : "var(--fg-muted)", boxShadow: (m === "BI") === isAnalytical ? "var(--shadow-1)" : "none", transition: "all .15s ease", display: "inline-flex", alignItems: "center", gap: 5 }}>
                {m === "BI" && <Database size={9} />}{m}
              </button>
            ))}
          </div>
          <button
            onClick={newThread}
            title="New thread"
            style={{ width: 32, height: 32, borderRadius: 10, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <Plus size={13} />
          </button>
          <button
            onClick={() => { navigator.clipboard.writeText(window.location.href); toast.success("Thread URL copied"); }}
            title="Share"
            style={{ width: 32, height: 32, borderRadius: 10, background: "var(--bg-muted)", border: "1px solid var(--border)", color: "var(--fg-muted)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <Share2 size={13} />
          </button>
          <Chip kind="outline"><ShieldCheck size={8} style={{ display: "inline", marginRight: 4 }} />Encrypted</Chip>
        </div>
      </div>

      {/* ── Body: [Thread sidebar | Messages | Intel sidebar] ──────────── */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>

        {/* Thread history sidebar (LEFT) ──────────────────────────────── */}
        <aside style={{
          width: showThreadSidebar ? 260 : 44,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          transition: "width .2s var(--ease-out)",
          background: "var(--bg)",
        }}>
          {/* Sidebar header row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: showThreadSidebar ? "space-between" : "center", padding: showThreadSidebar ? "14px 12px 10px" : "14px 0", flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
            {showThreadSidebar && (
              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--fg-muted)" }}>
                Threads
              </span>
            )}
            <button
              onClick={() => setShowSidebar(s => !s)}
              title={showThreadSidebar ? "Collapse sidebar" : "Expand thread history"}
              style={{ width: 26, height: 26, borderRadius: 8, border: "none", background: "transparent", color: "var(--fg-muted)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
            >
              {showThreadSidebar ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
            </button>
          </div>

          {showThreadSidebar && (
            <>
              {/* New thread */}
              <button
                onClick={newThread}
                style={{ margin: "8px 10px", padding: "7px 10px", borderRadius: 10, border: "1px dashed var(--border)", background: "transparent", color: "var(--fg-muted)", fontSize: 10, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer", display: "flex", alignItems: "center", gap: 7, flexShrink: 0, transition: "all .15s ease" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--primary)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(160,74,27,.3)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}
              >
                <Plus size={10} /> New Thread
              </button>

              {/* Thread list */}
              <div className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "0 6px 16px" }}>
                {threadsLoading && threads.length === 0 ? (
                  <div style={{ padding: "8px 6px", display: "flex", flexDirection: "column", gap: 6 }}>
                    {[0, 1, 2].map(i => (
                      <div key={i} style={{ height: 52, borderRadius: 10, background: "var(--bg-muted)", animation: "pulse-fade 1.5s ease-in-out infinite" }} />
                    ))}
                  </div>
                ) : threads.length === 0 ? (
                  <div style={{ padding: "20px 8px", textAlign: "center", fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.6 }}>
                    No threads yet.<br />Start a conversation to begin.
                  </div>
                ) : (
                  threads.map(t => (
                    <ThreadItem
                      key={t.id}
                      thread={t}
                      isActive={t.id === threadId}
                      onSelect={() => switchToThread(t.id)}
                      onDelete={() => deleteThread(t.id)}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </aside>

        {/* Messages + Composer ─────────────────────────────────────────── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div ref={scrollRef} className="custom-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "32px 40px" }}>
            <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", flexDirection: "column", gap: 28 }}>

              {/* Thread restore loading indicator */}
              {restoringThread && (
                <div style={{ display: "flex", justifyContent: "center", padding: "32px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 22px", borderRadius: 14, background: "var(--bg-elevated)", border: "1px solid var(--border)", fontSize: 12, color: "var(--fg-muted)", fontWeight: 500 }}>
                    <div style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--primary)", animation: "spin .8s linear infinite" }} />
                    Loading conversation…
                  </div>
                </div>
              )}

              {/* No-connections CTA */}
              {showNoConnections && (
                <div className="reveal" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "12px 0 4px", textAlign: "center" }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--fg-muted)", maxWidth: 400, lineHeight: 1.55 }}>
                    Your knowledge base is empty. Connect a data source to get answers grounded in your company's data.
                  </p>
                  <a href="/admin/integrations"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 18px", borderRadius: 999, background: "rgba(160,74,27,.10)", border: "1px solid rgba(160,74,27,.3)", fontSize: 11, fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--primary)", textDecoration: "none" }}>
                    Connect your first source <ArrowRight size={11} />
                  </a>
                </div>
              )}

              {/* Suggested prompts — first-message only */}
              {showSuggestedPrompts && (
                <div className="reveal" style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", padding: "8px 0 4px" }}>
                  {[
                    "What happened this week across my tools?",
                    "Summarise open engineering blockers",
                    "Show recent activity in my pipeline",
                    "What decisions were made last sprint?",
                  ].map(q => (
                    <button key={q} onClick={() => sendQuery(q)}
                      style={{ padding: "8px 16px", borderRadius: 999, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 11, fontWeight: 600, color: "var(--fg-muted)", cursor: "pointer", lineHeight: 1.4, transition: "all .15s ease" }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--primary)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(160,74,27,.35)"; (e.currentTarget as HTMLElement).style.background = "rgba(160,74,27,.06)"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; (e.currentTarget as HTMLElement).style.background = "var(--bg-muted)"; }}>
                      {q}
                    </button>
                  ))}
                </div>
              )}

              {/* Message bubbles */}
              {!restoringThread && messages.map(msg => {
                const isA = msg.role === "assistant";
                return (
                  <div key={msg.id} className="reveal" style={{ display: "flex", justifyContent: isA ? "flex-start" : "flex-end" }}>
                    <div style={{ display: "flex", gap: 14, maxWidth: "82%", flexDirection: isA ? "row" : "row-reverse" }}>
                      {/* Avatar */}
                      <div style={{ width: 38, height: 38, borderRadius: 12, flexShrink: 0, background: isA ? "rgba(160,74,27,.10)" : "var(--primary)", border: isA ? "1px solid rgba(160,74,27,.22)" : "none", color: isA ? "var(--primary)" : "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {isA ? (
                          <Sparkles size={18} strokeWidth={1.7} />
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                          </svg>
                        )}
                      </div>

                      {/* Bubble */}
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
                              <button onClick={() => { window.location.href = "/admin/keys"; }} style={{ alignSelf: "flex-start", padding: "8px 16px", borderRadius: 10, background: "#F59E0B", color: "#000", border: "none", fontSize: 9, fontWeight: 800, letterSpacing: "0.25em", textTransform: "uppercase", cursor: "pointer" }}>
                                Configure BYOK Keys
                              </button>
                            </div>
                          ) : (
                            <>
                              {isA && msg.steps && msg.steps.length > 0 && (
                                <div style={{ marginBottom: 12 }}>
                                  {/* Active step pill */}
                                  {!msg.content && (
                                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px", borderRadius: 999, background: "rgba(160,74,27,0.12)", border: "1px solid rgba(160,74,27,0.30)", marginBottom: 10 }}>
                                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--primary)", display: "inline-block", animation: "dot-bounce 1.2s infinite", flexShrink: 0 }} />
                                      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--primary)" }}>
                                        {msg.steps[msg.steps.length - 1]}
                                      </span>
                                    </div>
                                  )}
                                  {/* Past step badges */}
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
                                <div className="eyebrow" style={{ color: "var(--primary)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                                  <Database size={9} />BI Synthesis
                                </div>
                              )}
                              {msg.content ? (
                                <MarkdownMessage content={msg.content} />
                              ) : (
                                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                                  <div style={{ display: "flex", gap: 4 }}>
                                    {[0, 1, 2].map(j => (
                                      <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--primary)", animation: `dot-bounce 1.2s infinite ${j * 0.18}s` }} />
                                    ))}
                                  </div>
                                  <span className="eyebrow">Athene is synthesizing…</span>
                                </div>
                              )}
                            </>
                          )}

                          {/* Citations */}
                          {msg.cited_sources && msg.cited_sources.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16, paddingTop: 14, borderTop: "1px dashed var(--border)" }}>
                              {Array.from(
                                new Map(msg.cited_sources.map((s: any) => [s.document_id, s])).values()
                              ).map((s: any, idx: number) => {
                                const label = s.title || s.source_type || "Source";
                                const displayLabel = label.length > 32 ? label.slice(0, 32) + "…" : label;
                                const sharedStyle = { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: 8, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 10, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase" as const, color: "var(--fg-muted)" };
                                return s.external_url ? (
                                  <a key={idx} href={s.external_url} target="_blank" rel="noopener noreferrer" title={label} style={{ ...sharedStyle, textDecoration: "none" }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--primary)"; (e.currentTarget as HTMLElement).style.borderColor = "rgba(160,74,27,.3)"; }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}>
                                    <ExternalLink size={9} style={{ color: "var(--primary)", flexShrink: 0 }} />{displayLabel}
                                  </a>
                                ) : (
                                  <span key={idx} title={label} style={sharedStyle}>
                                    <ExternalLink size={9} style={{ color: "var(--primary)", flexShrink: 0 }} />{displayLabel}
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

          {/* Composer */}
          <Composer
            onSend={handleSend}
            isLoading={isLoading}
            isAnalytical={isAnalytical}
            placeholder={isAnalytical ? "SYNTHESIZE DEPARTMENT-WIDE BI PATTERNS…" : "ASK ATHENE TO SYNTHESIZE ANYTHING…"}
            prefillValue={prefill.value}
            prefillSeq={prefill.seq}
          />
        </div>

        {/* Intelligence sidebar (RIGHT) ────────────────────────────────── */}
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
              {[
                "Summarise this week's top decisions from Slack",
                "Which KPIs are trending down vs last quarter?",
                "Show open Jira blockers for engineering",
              ].map((q, i) => (
                <button key={i} onClick={() => sendQuery(q)}
                  style={{ textAlign: "left", padding: "9px 12px", borderRadius: 10, background: "var(--bg-muted)", border: "1px solid var(--border)", fontSize: 11, fontWeight: 500, color: "var(--fg-muted)", lineHeight: 1.45, cursor: "pointer", transition: "all .15s ease" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border-strong)"; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "var(--fg-muted)"; (e.currentTarget as HTMLElement).style.borderColor = "var(--border)"; }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <HitlModal
        isOpen={isHitlOpen}
        onClose={() => setIsHitlOpen(false)}
        threadId={threadId}
        pendingAction={pendingAction}
        onDecision={handleHitl}
      />

      <style>{`
        @keyframes dot-bounce  { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }
        @keyframes spin        { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes pulse-fade  { 0%,100%{opacity:1} 50%{opacity:.35} }
      `}</style>
    </div>
  );
}
