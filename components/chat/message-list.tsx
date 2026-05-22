"use client";

import { useEffect, useRef } from "react";
import { User, Zap, Loader2, Database, ExternalLink, GitBranch, AlertCircle, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  cited_sources?: CitedSource[];
  isAnalytical?: boolean;
  isLoading?: boolean;
  isQuotaError?: boolean;
}

export interface CitedSource {
  document_id: string;
  title: string | null;
  external_url?: string | null;
  chunk_index: number;
  source_type: string;
}

interface MessageListProps {
  messages: Message[];
  awaitingApproval?: boolean;
}

export function MessageList({ messages, awaitingApproval }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages.length]);

  function renderContent(content: string, citedSources?: CitedSource[]) {
    // Local regex instance to avoid concurrent render races
    const CITATION_REGEX = /\[([a-zA-Z0-9_-]+)\]/g;

    // Check whether there are any [EXTRACTED] tags even when citedSources is empty
    const hasAnyCitations = (citedSources && citedSources.length > 0) || /\[EXTRACTED\]/.test(content);
    if (!hasAnyCitations) {
      return <div className="whitespace-pre-wrap">{content}</div>;
    }

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = CITATION_REGEX.exec(content)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        parts.push(
          <span key={`text-${lastIndex}`}>
            {content.slice(lastIndex, match.index)}
          </span>
        );
      }

      const docId = match[1];

      // Knowledge-graph extracted relationship — purple chip, no external link
      if (docId === "EXTRACTED") {
        parts.push(
          <Tooltip key={`kg-${match.index}`}>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 bg-[#F0EEFF]/10 border border-[#C4BCF0]/20 rounded text-[10px] font-bold uppercase tracking-wider text-[#9B8FD4] cursor-default">
                <GitBranch className="w-2.5 h-2.5" />
                KG
              </span>
            </TooltipTrigger>
            <TooltipContent className="bg-black text-white border-white/10 text-xs max-w-xs">
              <p>Extracted from knowledge graph — not a stored document</p>
            </TooltipContent>
          </Tooltip>
        );
        lastIndex = CITATION_REGEX.lastIndex;
        continue;
      }

      const source = citedSources?.find((s) => s.document_id === docId);

      if (source) {
        parts.push(
          <Tooltip key={`cite-${docId}-${match.index}`}>
            <TooltipTrigger asChild>
              <span
                className="inline-flex items-center px-2 py-0.5 mx-0.5 bg-secondary/10 border border-secondary/20 rounded text-[10px] font-bold uppercase tracking-wider text-secondary cursor-pointer hover:bg-secondary/20 transition-colors"
                onClick={() => {
                  if (source.external_url) {
                    // noopener prevents the opened tab from accessing window.opener
                    window.open(source.external_url, "_blank", "noopener,noreferrer");
                  }
                }}
              >
                [{docId.slice(0, 8)}]
              </span>
            </TooltipTrigger>
            <TooltipContent className="bg-black text-white border-white/10 text-xs max-w-xs">
              <div className="space-y-1">
                <p className="font-bold">{source.title || "Untitled Document"}</p>
                <p className="text-muted-foreground">
                  Type: {source.source_type}
                </p>
                {source.external_url && (
                  <p className="text-secondary flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" />
                    Open document
                  </p>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      } else {
        parts.push(
          <span key={`cite-${docId}-${match.index}`}>[{docId}]</span>
        );
      }

      lastIndex = CITATION_REGEX.lastIndex;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      parts.push(
        <span key={`text-${lastIndex}`}>{content.slice(lastIndex)}</span>
      );
    }

    return <div className="whitespace-pre-wrap">{parts}</div>;
  }

  return (
    <TooltipProvider>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-10"
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            data-testid={msg.role === "assistant" ? "assistant-message" : "user-message"}
            data-loading={msg.isLoading ? "true" : "false"}
            className={cn(
              "flex w-full animate-in fade-in slide-in-from-bottom-4 duration-500",
              msg.role === "user" ? "justify-end" : "justify-start"
            )}
          >
            <div
              className={cn(
                "flex max-w-[85%] gap-5",
                msg.role === "user" && "flex-row-reverse"
              )}
            >
              <div
                className={cn(
                  "h-11 w-11 shrink-0 rounded-2xl flex items-center justify-center border shadow-sm",
                  msg.role === "assistant"
                    ? "bg-muted border-border text-muted-foreground"
                    : "bg-primary/10 border-primary/20 text-primary"
                )}
              >
                {msg.role === "assistant" ? (
                  msg.isLoading ? (
                    <Loader2 className="h-5.5 w-5.5 animate-spin" />
                  ) : (
                    <Zap className="h-5.5 w-5.5" />
                  )
                ) : (
                  <User className="h-5.5 w-5.5" />
                )}
              </div>

              <div className="space-y-2">
                <div
                  className={cn(
                    "p-6 rounded-[2rem] text-[15px] leading-relaxed font-medium shadow-sm transition-all hover:shadow-md",
                    msg.role === "assistant"
                      ? "bg-card border border-border text-foreground"
                      : "bg-primary text-white border-none shadow-[var(--shadow-2)]"
                  )}
                >
                  {msg.isQuotaError ? (
                    <div className="space-y-6 p-2">
                      <div className="flex items-start gap-4">
                        <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-2xl shrink-0">
                          <AlertCircle className="w-6 h-6 animate-pulse" />
                        </div>
                        <div className="space-y-1">
                          <h4 className="text-sm font-black uppercase tracking-widest text-amber-500">
                            LLM Quota Exceeded
                          </h4>
                          <p className="text-xs text-muted-foreground/85 font-medium leading-relaxed">
                            {msg.content}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-3 pt-4 border-t border-white/5">
                        <button
                          onClick={() => window.location.href = "/admin/keys"}
                          className="h-10 px-5 bg-amber-500 text-black hover:bg-amber-400 font-black uppercase tracking-widest text-[10px] rounded-xl flex items-center gap-2 shadow-lg shadow-amber-500/10 transition-colors border-none"
                        >
                          Configure BYOK Keys
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {msg.isAnalytical && msg.role === "assistant" && (
                        <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.2em] font-bold text-secondary mb-4 border-b border-border/30 pb-3 w-fit">
                          <Database className="w-4 h-4" />
                          Business Intelligence Synthesis
                        </div>
                      )}

                      {msg.isLoading && !msg.content ? (
                        <div className="flex items-center gap-4 py-2">
                          <Loader2 className="w-5 h-5 animate-spin text-primary" />
                          <span className="text-muted-foreground animate-pulse text-[12px] font-bold uppercase tracking-widest">
                            Athene is Synthesizing...
                          </span>
                        </div>
                      ) : (
                        renderContent(msg.content, msg.cited_sources)
                      )}
                    </>
                  )}

                  {msg.cited_sources && msg.cited_sources.length > 0 && (
                    <div className="mt-8 flex flex-wrap gap-3 pt-6 border-t border-white/5">
                      {msg.cited_sources.map((source, idx) => (
                        <Tooltip key={`${source.document_id}-${idx}`}>
                          <TooltipTrigger asChild>
                            {source.external_url ? (
                              <a
                                href={source.external_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid="cited-source"
                                className="inline-flex items-center gap-3 px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-[11px] font-bold uppercase tracking-widest text-muted-foreground hover:text-primary hover:border-primary/30 transition-all duration-200"
                              >
                                <ExternalLink className="w-3.5 h-3.5 text-secondary" />
                                {source.source_type || "Source"}
                              </a>
                            ) : (
                              <span
                                data-testid="cited-source"
                                className="inline-flex items-center gap-3 px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-[11px] font-bold uppercase tracking-widest text-muted-foreground"
                              >
                                <ExternalLink className="w-3.5 h-3.5 text-secondary" />
                                {source.source_type || "Source"}
                              </span>
                            )}
                          </TooltipTrigger>
                          <TooltipContent className="bg-black text-white border-white/10 text-[10px] font-bold uppercase tracking-widest">
                            Document ID: {source.document_id.slice(0, 8)}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  )}
                </div>

                <div
                  className={cn(
                    "flex items-center gap-3 px-6 mt-1",
                    msg.role === "user" && "flex-row-reverse"
                  )}
                >
                  <span className="text-[11px] font-bold text-muted-foreground/40 uppercase tracking-widest opacity-60">
                    {msg.timestamp}
                  </span>
                  {msg.role === "assistant" && (
                    <div className="flex gap-2">
                      <div className="h-1.5 w-1.5 rounded-full bg-white/10" />
                      <div className="h-1.5 w-1.5 rounded-full bg-white/10" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}

        {awaitingApproval && (
          <div className="flex justify-center">
            <div className="px-4 py-2 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-400 text-xs font-bold uppercase tracking-widest">
              Awaiting approval...
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
