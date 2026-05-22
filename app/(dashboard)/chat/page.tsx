"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  BrainCircuit,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  History,
  Layout,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  User,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HitlModal } from "@/components/chat/hitl-modal";
import { toast } from "sonner";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  type?: "standard" | "bi";
  timestamp: string;
  cited_sources?: any[];
  isAnalytical?: boolean;
  awaiting_approval?: boolean;
  isQuotaError?: boolean;
}

interface ThreadSummary {
  id: string;
  title: string | null;
  last_message_at: string | null;
  message_count: number;
  created_at: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "initial-assistant",
      role: "assistant",
      content: "Welcome to the Athene Synthesis Environment. I've initialized your organizational knowledge graph. How can I assist your objectives today?",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyticalMode, setIsAnalyticalMode] = useState(false);
  const [threadId, setThreadId] = useState<string>("");
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [isHitlModalOpen, setIsHitlModalOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ tool: string; payload: any } | null>(null);
  const [sseReconnecting, setSseReconnecting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setThreadId(crypto.randomUUID());
    // Load existing threads for the history sidebar
    fetch('/api/threads')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => setThreads(data.threads ?? []))
      .catch((err) => {
        console.warn('[chat] Failed to load thread history:', err.message);
        // Non-fatal — user can still chat; show nothing rather than crash
      });
  }, []);

  /** Switch to an existing thread and reset the message history */
  function selectThread(id: string) {
    setThreadId(id);
    setMessages([{
      id: "initial-assistant",
      role: "assistant",
      content: "Resuming session — I have context from our previous conversation. How can I help?",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }]);
  }

  /** Create a brand new thread */
  function newThread() {
    setThreadId(crypto.randomUUID());
    setMessages([{
      id: "initial-assistant",
      role: "assistant",
      content: "Welcome to the Athene Synthesis Environment. I've initialized your organizational knowledge graph. How can I assist your objectives today?",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }]);
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const userMessage = input.trim();
    if (!userMessage || isLoading) return;

    const userEntry: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: userMessage,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages((prev) => [...prev, userEntry]);
    setInput("");
    setIsLoading(true);

    const assistantId = `assistant-${Date.now()}`;
    const assistantEntry: Message = { 
        id: assistantId, 
        role: "assistant", 
        content: "", 
        isAnalytical: isAnalyticalMode,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    setMessages((prev) => [...prev, assistantEntry]);

    // SSE with exponential backoff reconnect (max 3 attempts)
    const MAX_RETRIES = 3;
    let attempt = 0;
    let success = false;

    while (attempt <= MAX_RETRIES && !success) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        setSseReconnecting(true);
        await new Promise(r => setTimeout(r, backoffMs));
        setSseReconnecting(false);
      }

      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: userMessage,
            threadId,
            task_type: isAnalyticalMode ? "analytical" : "general"
          }),
        });

        if (res.status === 429) {
          const retryAfter = res.headers.get('Retry-After') ?? '60';
          toast.error(`Rate limit reached. Try again in ${retryAfter}s.`);
          break;
        }

        if (!res.ok || !res.body) throw new Error(`Server error: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const payload = JSON.parse(line.slice(6));

              if (payload.error) {
                const errMsg = payload.content || "An error occurred. Please try again.";
                const isQuota = /quota exceeded|quota|rate_limit|billing|BYOK/i.test(errMsg);

                if (isQuota) {
                  toast.error("LLM Quota Exceeded. Please configure a BYOK key in Admin -> Keys.", {
                    action: {
                      label: "Admin Keys",
                      onClick: () => window.location.href = "/admin/keys"
                    },
                    duration: 10000
                  });
                }

                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: errMsg, isQuotaError: isQuota }
                      : m
                  )
                );
              } else if (payload.token) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: m.content + payload.token }
                      : m
                  )
                );
              } else if (
                payload.content ||
                payload.cited_sources !== undefined ||
                payload.awaiting_approval !== undefined
              ) {
                // Values frame — carries metadata (cited_sources, awaiting_approval)
                // and optionally content for non-streaming responses.
                // Safety rule: never overwrite accumulated token content with a shorter
                // string. The backend already omits `content` when tokens are streaming,
                // but this guard protects against any edge-case ordering issues.
                setMessages((prev) =>
                  prev.map((m) => {
                    if (m.id !== assistantId) return m;
                    const newContent =
                      payload.content && payload.content.length > m.content.length
                        ? payload.content
                        : m.content;
                    return {
                      ...m,
                      content: newContent,
                      cited_sources: payload.cited_sources || m.cited_sources,
                      awaiting_approval: payload.awaiting_approval ?? m.awaiting_approval,
                    };
                  })
                );

                if (payload.awaiting_approval && payload.pending_write_action) {
                  setPendingAction(payload.pending_write_action);
                  setIsHitlModalOpen(true);
                }
              }
            } catch { /* malformed SSE frame — skip */ }
          }
        }
        success = true;
        // Refresh thread list after successful response
        fetch('/api/threads')
          .then(r => r.ok ? r.json() : { threads: [] })
          .then(data => setThreads(data.threads ?? []))
          .catch(() => {});
      } catch (err) {
        attempt++;
        if (attempt > MAX_RETRIES) {
          console.error("[chat] SSE failed after max retries:", err);
          toast.error("Connection lost. Please try again.");
          // Replace the empty assistant bubble with an explicit error so the
          // spinner doesn't spin forever.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId && m.content === ""
                ? { ...m, content: "⚠ Connection lost. Please try again." }
                : m
            )
          );
        }
      }
    }

    setIsLoading(false);
    setSseReconnecting(false);
  }

  async function handleHitlDecision(action: 'approve' | 'reject' | 'edit', edits?: any) {
    try {
      const res = await fetch(`/api/threads/${threadId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, edits }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to process decision");
      }

      toast.success(`Action ${action}ed successfully`);
      setPendingAction(null);
      setIsHitlModalOpen(false);

      // Backend resumes the graph in the background after approval.
      // Surface a status message so the user knows something happened.
      const statusContent =
        action === "approve"
          ? "✓ Action approved — executing in the background."
          : "✗ Action rejected.";
      setMessages((prev) => [
        ...prev,
        {
          id: `hitl-status-${Date.now()}`,
          role: "assistant",
          content: statusContent,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } catch (error: any) {
      toast.error(error.message);
      throw error;
    }
  }

  return (
    <div className="flex h-[calc(100vh-120px)] flex-col gap-8 animate-in fade-in slide-in-from-bottom-4 duration-700 overflow-hidden font-['Space_Grotesk'] transition-colors duration-300">
      <div className="flex flex-1 gap-8 overflow-hidden">
        
        {/* Main Conversation Column */}
        <div className="flex flex-1 flex-col min-w-0 gap-6">
          
          {/* Header Section */}
          <div className="flex items-center justify-between bg-card/50 p-4 sm:p-6 rounded-[2rem] sm:rounded-[2.5rem] border border-border shadow-2xl backdrop-blur-xl">
            <div className="flex items-center gap-5">
              <div className="h-12 w-12 bg-white rounded-2xl flex items-center justify-center shadow-lg border border-border/50 group hover:scale-105 transition-transform">
                <img src="/logo.png" alt="A" className="h-8 w-8 object-contain" />
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-black tracking-tight text-foreground uppercase tracking-widest">Synthesis <span className="text-primary">v4.2</span></h2>
                  <Badge className="bg-accent/10 text-accent border-accent/20 text-[9px] font-black h-4.5 px-2 tracking-widest uppercase">LIVE</Badge>
                </div>
                <p className="text-[10px] text-muted-foreground font-black uppercase tracking-[0.2em] flex items-center gap-2 mt-0.5">
                   <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                   Encrypted Pipeline
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
               <Tabs 
                    value={isAnalyticalMode ? "analytical" : "standard"} 
                    onValueChange={(v) => setIsAnalyticalMode(v === "analytical")}
                    className="hidden md:block"
                >
                    <TabsList className="bg-muted/30 border border-border p-1 rounded-xl h-11">
                    <TabsTrigger value="standard" className="rounded-lg px-6 text-[10px] font-black uppercase tracking-[0.2em] transition-all data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-lg">
                        Standard
                    </TabsTrigger>
                    <TabsTrigger value="analytical" className="rounded-lg px-6 text-[10px] font-black uppercase tracking-[0.2em] transition-all data-[state=active]:bg-secondary data-[state=active]:text-secondary-foreground data-[state=active]:shadow-lg flex items-center gap-2">
                        <Database className="w-3.5 h-3.5" />
                        Analytical
                    </TabsTrigger>
                    </TabsList>
                </Tabs>
               <div className="flex items-center gap-2 pr-2">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={newThread}
                          className="h-11 w-11 rounded-xl hover:bg-primary/10 hover:text-primary border border-transparent hover:border-primary/10 transition-all"
                          aria-label="New conversation"
                        >
                          <RefreshCcw className="w-4.5 h-4.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>New conversation</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
               </div>
            </div>
          </div>

          {/* Messages Area */}
          <ScrollArea className="flex-1 px-4 custom-scrollbar">
            <div className="space-y-10 py-6" ref={scrollRef}>
              {messages.map((msg, i) => (
                <div
                  key={msg.id}
                  data-testid={msg.role === "user" ? "user-message" : "assistant-message"}
                  className={cn(
                    "flex w-full animate-in fade-in slide-in-from-bottom-4 duration-500",
                    msg.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  <div className={cn(
                    "flex max-w-[85%] gap-5",
                    msg.role === "user" && "flex-row-reverse"
                  )}>
                    <div className={cn(
                      "h-11 w-11 shrink-0 rounded-2xl flex items-center justify-center border shadow-xl transition-all group hover:scale-110",
                      msg.role === "assistant" 
                        ? "bg-white border-border text-black" 
                        : "bg-gradient-to-br from-primary to-secondary border-none text-white"
                    )}>
                      {msg.role === "assistant" ? <img src="/logo.png" alt="A" className="w-6 h-6 object-contain" /> : <User className="h-5.5 w-5.5" />}
                    </div>
                    
                    <div className="space-y-3">
                      <div className={cn(
                        "p-4 sm:p-6 md:p-8 rounded-[1.5rem] sm:rounded-[2rem] md:rounded-[2.5rem] text-[14px] sm:text-[15px] leading-relaxed font-bold shadow-2xl transition-all hover:shadow-primary/5",
                        msg.role === "assistant" 
                          ? "bg-card/50 border border-border text-foreground backdrop-blur-xl" 
                          : "bg-gradient-to-r from-primary to-secondary text-primary-foreground border-none"
                      )}>
                        {msg.isQuotaError ? (
                          <div className="space-y-6">
                            <div className="flex items-start gap-4">
                              <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-2xl shrink-0">
                                <AlertCircle className="w-6 h-6 animate-pulse" />
                              </div>
                              <div className="space-y-1">
                                <h4 className="text-sm font-black uppercase tracking-widest text-amber-500">
                                  LLM Quota Exceeded
                                </h4>
                                <p className="text-xs text-muted-foreground/80 font-bold leading-relaxed">
                                  {msg.content}
                                </p>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-3 pt-4 border-t border-border/50">
                              <Button
                                onClick={() => window.location.href = "/admin/keys"}
                                className="h-10 px-5 bg-amber-500 text-black hover:bg-amber-400 font-black uppercase tracking-widest text-[10px] rounded-xl flex items-center gap-2 shadow-lg shadow-amber-500/10 border-none"
                              >
                                Configure BYOK Keys
                                <ChevronRight className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {msg.isAnalytical && msg.role === "assistant" && (
                                <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.3em] font-black text-primary mb-6 border-b border-border/50 pb-4 w-fit">
                                    <Database className="w-4 h-4" />
                                    Business Intelligence Synthesis
                                </div>
                            )}
                            <div className="whitespace-pre-wrap tracking-tight">
                                {msg.content || (
                                <div className="flex items-center gap-5 py-3">
                                    <div className="flex gap-1">
                                      <div className="w-2 h-2 rounded-full bg-primary animate-bounce [animation-delay:-0.3s]" />
                                      <div className="w-2 h-2 rounded-full bg-primary animate-bounce [animation-delay:-0.15s]" />
                                      <div className="w-2 h-2 rounded-full bg-primary animate-bounce" />
                                    </div>
                                    <span className="text-muted-foreground/40 text-[11px] font-black uppercase tracking-[0.3em]">Synthesizing Reality...</span>
                                </div>
                                )}
                            </div>
                          </>
                        )}
                        
                        {msg.cited_sources && msg.cited_sources.length > 0 && (
                          <div className="mt-10 flex flex-wrap gap-3 pt-8 border-t border-border/50">
                             {msg.cited_sources.map((source, idx) => (
                                <TooltipProvider key={idx}>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <a 
                                                href={source.external_url || "#"}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="inline-flex items-center gap-3 px-5 py-2.5 bg-muted/20 border border-border rounded-xl text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-primary hover:border-primary/40 hover:bg-muted/40 transition-all duration-300 shadow-sm"
                                            >
                                                <ExternalLink className="w-3.5 h-3.5 text-primary" />
                                                {source.source_type || "Source"}
                                            </a>
                                        </TooltipTrigger>
                                        <TooltipContent className="bg-popover text-popover-foreground border-border text-[9px] font-black uppercase tracking-[0.2em] shadow-2xl">
                                            Document ID: {source.document_id?.slice(0, 8)}
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                             ))}
                          </div>
                        )}
                      </div>
                      <div className={cn(
                        "flex items-center gap-3 px-3 sm:px-6 md:px-8 mt-1",
                        msg.role === "user" && "flex-row-reverse"
                      )}>
                        <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest opacity-40">{msg.timestamp}</span>
                        {msg.role === "assistant" && (
                          <div className="flex items-center gap-2">
                             <div className="h-1 w-1 rounded-full bg-primary" />
                             <span className="text-[9px] font-black text-primary uppercase tracking-[0.2em]">Verified Synthesis</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>

          {/* Input Bar */}
          <div className="bg-card/50 p-3 sm:p-4 md:p-5 rounded-[2rem] sm:rounded-[3rem] md:rounded-[3.5rem] border border-border flex flex-col gap-3 shadow-2xl shadow-black/40 relative z-10 mx-2 sm:mx-6 lg:mx-10 mb-4 sm:mb-6 group focus-within:border-primary/50 focus-within:shadow-primary/5 transition-all backdrop-blur-2xl">
            <div className="flex items-center gap-5">
                <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-5">
                    <input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        disabled={isLoading}
                        placeholder={isAnalyticalMode ? "Synthesize department-wide BI patterns..." : "Ask Athene to synthesize anything..."}
                        className="flex-1 bg-transparent border-none focus:outline-none text-foreground text-base font-bold placeholder:text-muted-foreground/30 placeholder:font-black placeholder:uppercase placeholder:tracking-[0.2em] h-14 pl-4"
                    />
                    
                    <div className="flex items-center gap-4 pr-3">
                        <Button 
                            type="submit"
                            disabled={isLoading || !input.trim()}
                            className="h-14 w-14 rounded-full bg-gradient-to-br from-primary to-secondary text-primary-foreground hover:shadow-2xl hover:shadow-primary/20 transition-all active:scale-95 flex items-center justify-center border-none"
                        >
                            {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : <Send className="w-6 h-6 fill-primary-foreground" />}
                        </Button>
                    </div>
                </form>
            </div>
          </div>
        </div>

        {/* Intelligence Sidebar */}
        <aside className="hidden xl:flex w-80 flex-col gap-8 pr-4 pb-10 overflow-y-auto custom-scrollbar">
           {/* Thread History */}
           <Card className="bg-card/50 backdrop-blur-xl border border-border p-8 space-y-6 rounded-[2.5rem] shadow-2xl transition-colors duration-300">
              <div className="flex items-center justify-between">
                <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground flex items-center gap-2">
                  <History className="w-4 h-4" /> Sessions
                </h3>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={newThread}
                  className="h-8 w-8 rounded-xl hover:bg-primary/10 hover:text-primary transition-all"
                  title="New thread"
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                {threads.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground/40 font-black uppercase tracking-widest py-4 text-center">No prior sessions</p>
                ) : threads.map((t) => {
                  const ts = t.last_message_at ?? t.created_at
                  const date = new Date(ts)
                  const label = t.title || date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  const isActive = t.id === threadId
                  return (
                    <button
                      key={t.id}
                      onClick={() => selectThread(t.id)}
                      className={cn(
                        "w-full flex items-start gap-3 p-4 rounded-2xl text-left border transition-all",
                        isActive
                          ? "bg-primary/10 border-primary/30 text-primary"
                          : "border-transparent hover:bg-muted/30 hover:border-border text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-60" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-black uppercase tracking-tight truncate">{label}</p>
                        <p className="text-[9px] opacity-50 mt-0.5">{time} · {t.message_count} msg{t.message_count !== 1 ? 's' : ''}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
              {sseReconnecting && (
                <p className="text-[10px] font-black text-amber-500 uppercase tracking-widest text-center animate-pulse">Reconnecting…</p>
              )}
           </Card>

           <Card className="bg-card/50 backdrop-blur-xl border border-border p-10 space-y-8 rounded-[2.5rem] shadow-2xl transition-colors duration-300">
              <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground">Session Context</h3>
              {(() => {
                const userMsgs = messages.filter(m => m.role === 'user').length;
                const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content && !m.content.startsWith('⚠') && !m.content.startsWith('✓') && !m.content.startsWith('✗'));
                const sourceCount = lastAssistant?.cited_sources?.length ?? 0;
                return (
                  <div className="space-y-4">
                    <div className="p-5 rounded-2xl bg-muted/20 border border-border/50 space-y-3">
                      <div className="flex items-center justify-between">
                        <Layout className="w-5 h-5 text-primary" />
                        <Badge className="bg-primary/10 text-primary border-primary/20 text-[9px] font-black uppercase tracking-widest">
                          {isAnalyticalMode ? 'BI Mode' : 'Standard'}
                        </Badge>
                      </div>
                      <p className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Thread</p>
                      <p className="text-[11px] font-black text-foreground font-mono truncate">{threadId.slice(0, 8)}…</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-4 rounded-2xl bg-muted/20 border border-border/50 text-center">
                        <p className="text-xl font-black text-primary">{userMsgs}</p>
                        <p className="text-[9px] font-black text-muted-foreground uppercase tracking-widest mt-1">Messages</p>
                      </div>
                      <div className="p-4 rounded-2xl bg-muted/20 border border-border/50 text-center">
                        <p className="text-xl font-black text-accent">{sourceCount}</p>
                        <p className="text-[9px] font-black text-muted-foreground uppercase tracking-widest mt-1">Sources</p>
                      </div>
                    </div>
                  </div>
                );
              })()}
           </Card>

           <Card className="bg-card/50 backdrop-blur-xl border border-border flex-1 p-10 space-y-10 overflow-hidden rounded-[2.5rem] shadow-2xl transition-colors duration-300">
              <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground">Active Reasoning</h3>
              {(() => {
                const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
                const hasSources = (lastAssistant?.cited_sources?.length ?? 0) > 0;
                const agents = [
                  {
                    name: "Retrieval Scout",
                    status: isLoading ? "Searching…" : hasSources ? "Complete" : "Standby",
                    icon: Search,
                    color: isLoading ? "text-primary" : hasSources ? "text-accent" : "text-muted-foreground/40",
                    bg: isLoading ? "bg-primary/10" : hasSources ? "bg-accent/10" : "bg-muted/10",
                    pulse: isLoading,
                  },
                  {
                    name: "Logic Engine",
                    status: isLoading ? "Processing…" : "Standby",
                    icon: BrainCircuit,
                    color: isLoading ? "text-primary" : "text-muted-foreground/40",
                    bg: isLoading ? "bg-primary/10" : "bg-muted/10",
                    pulse: isLoading,
                  },
                  {
                    name: "Audit Sentry",
                    status: "Watching",
                    icon: ShieldCheck,
                    color: "text-accent",
                    bg: "bg-accent/10",
                    pulse: false,
                  },
                ];
                return (
                  <div className="space-y-4">
                    {agents.map((agent, i) => (
                      <div key={i} className="flex items-center justify-between p-5 rounded-2xl bg-muted/10 border border-border transition-all shadow-sm">
                        <div className="flex items-center gap-4">
                          <div className={cn("p-3 rounded-xl border border-border transition-colors", agent.bg)}>
                            <agent.icon className={cn("w-4 h-4 transition-colors", agent.color, agent.pulse && "animate-pulse")} />
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[11px] font-black text-foreground uppercase tracking-tight">{agent.name}</span>
                            <span className={cn("text-[9px] font-black uppercase tracking-[0.2em] mt-0.5", agent.pulse ? "text-primary" : "text-muted-foreground/50")}>{agent.status}</span>
                          </div>
                        </div>
                        {agent.pulse && <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />}
                      </div>
                    ))}
                  </div>
                );
              })()}
           </Card>
        </aside>
      </div>


      <HitlModal 
        isOpen={isHitlModalOpen}
        onClose={() => setIsHitlModalOpen(false)}
        threadId={threadId}
        pendingAction={pendingAction}
        onDecision={handleHitlDecision}
      />
    </div>
  );
}
