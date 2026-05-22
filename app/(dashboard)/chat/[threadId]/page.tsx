"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { BrainCircuit, Database, Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThreadSidebar } from "@/components/chat/thread-sidebar";
import { MessageList, Message } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { ApprovalCard } from "@/components/chat/approval-card";
import { PendingWriteAction } from "@/lib/langgraph/state";
import { toast } from "sonner";

export default function ThreadChatPage() {
  const params = useParams<{ threadId: string }>();
  const router = useRouter();
  const threadId = params.threadId;

  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyticalMode, setIsAnalyticalMode] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingWriteAction | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount — abort any in-flight request without nulling ref
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  // Reset state when threadId changes
  useEffect(() => {
    setMessages([]);
    setIsLoading(false);
  }, [threadId]);

  // Fetch initial thread state
  useEffect(() => {
    if (!threadId) return;

    async function fetchThreadState() {
      try {
        const res = await fetch(`/api/agent/status?threadId=${threadId}`);
        if (!res.ok) return;

        const data = await res.json();
        if (data.values?.messages) {
          const msgs = data.values.messages;
          const loadedMessages: Message[] = msgs.map(
            (msg: any, idx: number) => {
              const isLast = idx === msgs.length - 1;
              const isAssistant = msg.type !== "human";
              return {
                id: msg.id || `msg-${idx}`,
                role: isAssistant ? "assistant" : "user",
                content: msg.content,
                timestamp: new Date().toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
                cited_sources: (isLast && isAssistant)
                  ? (data.values.cited_sources || [])
                  : [],
              };
            }
          );
          setMessages(loadedMessages);
        }

        setAwaitingApproval(data.values?.awaiting_approval || false);
        setPendingAction(data.values?.pending_write_action || null);
      } catch (err) {
        console.error("Failed to fetch thread state:", err);
      }
    }

    fetchThreadState();
  }, [threadId]);

  const handleStreamMessage = useCallback((data: any) => {
    if (data.error) {
      const errMsg = data.content || "An error occurred.";
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
          m.isLoading
            ? {
                ...m,
                content: errMsg,
                isLoading: false,
                isQuotaError: isQuota,
              }
            : m
        )
      );
      setIsLoading(false);
      return;
    }

    setMessages((prev) => {
      const lastAssistant = [...prev]
        .reverse()
        .find((m) => m.role === "assistant" && m.isLoading);

      if (lastAssistant) {
        return prev.map((m) =>
          m.id === lastAssistant.id
            ? {
                ...m,
                content: data.content || m.content,
                cited_sources: data.cited_sources || m.cited_sources,
              }
            : m
        );
      }
      return prev;
    });

    setAwaitingApproval(data.awaiting_approval || false);
    setPendingAction(data.pending_write_action || null);

    if (data.final_answer || data.run_status === "completed" || data.run_status === "idle") {
      setIsLoading(false);
      setMessages((prev) =>
        prev.map((m) => (m.isLoading ? { ...m, isLoading: false } : m))
      );
    }
  }, []);

  const handleStreamError = useCallback((error: Error) => {
    console.error("Stream error:", error);
    setIsLoading(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.isLoading
          ? {
              ...m,
              content: `Error: ${error.message}`,
              isLoading: false,
            }
          : m
      )
    );
  }, []);

  // Shared streaming logic for both send and resume
  const streamFromUrl = useCallback(async (url: string, body: object) => {
    if (!threadId) return;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Server error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            handleStreamMessage(data);
          } catch {
            // Ignore parse errors
          }
        }
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        handleStreamError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      abortRef.current = null;
    }
  }, [handleStreamMessage, handleStreamError]);

  async function handleSend(message: string) {
    if (!message.trim() || isLoading || !threadId) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: message,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    const assistantMessage: Message = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      isLoading: true,
      isAnalytical: isAnalyticalMode,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setIsLoading(true);

    await streamFromUrl("/api/agent", {
      message,
      threadId,
      task_type: isAnalyticalMode ? "analytical" : "general",
    });
  }

  function handleApprovalComplete(content: string, citedSources: any[]) {
    setAwaitingApproval(false);
    setPendingAction(null);
    setIsLoading(false);

    if (content) {
      setMessages((prev) =>
        prev.map((m) =>
          m.isLoading
            ? {
                ...m,
                content,
                cited_sources: citedSources,
                isLoading: false,
              }
            : m
        )
      );
    }
  }

  return (
    <div className="flex h-[calc(100vh-120px)] gap-8 overflow-hidden">
      <ThreadSidebar />

      <div className="flex-1 flex flex-col min-w-0 gap-6">
        {/* Header */}
        <div className="flex items-center justify-between bg-accent/20 p-6 rounded-[2.5rem] border border-white/5 shadow-sm">
          <div className="flex items-center gap-5">
            <div className="h-12 w-12 bg-primary rounded-2xl flex items-center justify-center shadow-md">
              <BrainCircuit className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-base font-black tracking-tight text-foreground">
                  Synthesis v4.2
                </h2>
                <Badge className="bg-emerald-500/10 text-emerald-400 border-none text-[9px] font-bold h-4.5 px-2">
                  LIVE
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground/40 font-bold uppercase tracking-[0.15em] flex items-center gap-2 mt-0.5">
                <ShieldCheck className="w-3.5 h-3.5 text-[#5290B8]" />
                Encrypted Pipeline
              </p>
            </div>
          </div>

          <Tabs
            value={isAnalyticalMode ? "analytical" : "standard"}
            onValueChange={(v) => setIsAnalyticalMode(v === "analytical")}
            className="hidden md:block"
          >
            <TabsList className="bg-background/50 border border-white/5 p-1 rounded-xl h-11">
              <TabsTrigger
                value="standard"
                className="rounded-lg px-6 text-[10px] font-bold uppercase tracking-wider transition-all data-[state=active]:bg-white/10 data-[state=active]:text-primary data-[state=active]:shadow-sm"
              >
                Standard
              </TabsTrigger>
              <TabsTrigger
                value="analytical"
                className="rounded-lg px-6 text-[10px] font-bold uppercase tracking-wider transition-all data-[state=active]:bg-white/10 data-[state=active]:text-primary data-[state=active]:shadow-sm flex items-center gap-2"
              >
                <Database className="w-3.5 h-3.5" />
                Analytical
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Messages */}
        <MessageList messages={messages} awaitingApproval={awaitingApproval} />

        {/* Approval Card */}
        {awaitingApproval && pendingAction && (
          <ApprovalCard
            threadId={threadId}
            action={pendingAction}
            onComplete={handleApprovalComplete}
          />
        )}

        {/* Composer */}
        <Composer
          onSend={handleSend}
          isLoading={isLoading}
          isAnalytical={isAnalyticalMode}
        />
      </div>
    </div>
  );
}
