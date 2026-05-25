"use client";

// ============================================================
// components/chat/markdown-message.tsx
//
// Unified content renderer for assistant chat bubbles.
// Handles three concerns in one place:
//
//   1. <think>...</think> blocks (DeepSeek / reasoning models) —
//      hidden behind a collapsible "Reasoning" disclosure element.
//
//   2. Markdown rendering — bold, headers, lists, code blocks, etc.
//      via react-markdown + remark-gfm.
//
//   3. Citation chips — [docId] tokens rendered as styled inline
//      chips with tooltips linking to the source document, interleaved
//      correctly inside the markdown text.
//
// Used by:
//   - components/chat/message-list.tsx  (threadId route)
//   - app/(dashboard)/chat/page.tsx     (new-thread route)
// ============================================================

import { Brain, ChevronRight, ExternalLink, GitBranch } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────

export interface CitedSource {
  document_id: string;
  title: string | null;
  external_url?: string | null;
  chunk_index: number;
  source_type: string;
}

export interface MarkdownMessageProps {
  content: string;
  citedSources?: CitedSource[];
  /** Extra className for the wrapper div */
  className?: string;
}

// ── Thinking parser ──────────────────────────────────────────

interface ThinkingResult {
  /** Extracted thinking text (empty string if none) */
  thinking: string;
  /** The response text after the thinking block */
  mainContent: string;
  /** True while streaming and <think> block is not yet closed */
  isThinking: boolean;
}

function parseThinkingContent(content: string): ThinkingResult {
  // Complete block: <think>...</think> at the very start of content
  const match = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
  if (match) {
    return {
      thinking: match[1].trim(),
      mainContent: content.slice(match[0].length).trim(),
      isThinking: false,
    };
  }
  // In-progress: <think> opened but not yet closed (still streaming)
  if (content.startsWith("<think>")) {
    return {
      thinking: content.slice("<think>".length),
      mainContent: "",
      isThinking: true,
    };
  }
  return { thinking: "", mainContent: content, isThinking: false };
}

// ── Citation regex ───────────────────────────────────────────

// Pattern only — no /g flag. A new RegExp instance with /g is created per render
// call below because stateful global regexes share lastIndex across invocations.
const CITATION_PATTERN = /\[([a-zA-Z0-9_-]+)\]/;

// ── Main component ───────────────────────────────────────────

export function MarkdownMessage({
  content,
  citedSources,
  className,
}: MarkdownMessageProps) {
  const { thinking, mainContent, isThinking } = parseThinkingContent(content);

  return (
    <div className={cn("space-y-3", className)}>
      {/* ── Thinking disclosure ───────────────────────────── */}
      {(thinking || isThinking) && (
        // Auto-open while still streaming so the user can read in-progress tokens.
        // Collapses automatically once the </think> block closes (isThinking → false).
        <details className="group" open={isThinking}>
          <summary className="flex items-center gap-2 cursor-pointer select-none list-none text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors">
            <Brain className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{isThinking ? "Thinking…" : "Reasoning"}</span>
            <ChevronRight className="w-3 h-3 transition-transform duration-200 group-open:rotate-90" />
          </summary>
          <div className="mt-2 pl-4 border-l-2 border-border/50 text-[12px] text-muted-foreground/55 whitespace-pre-wrap leading-relaxed">
            {thinking || <span className="animate-pulse">…</span>}
          </div>
        </details>
      )}

      {/* ── Main response content ────────────────────────── */}
      {mainContent && (
        <MarkdownWithCitations content={mainContent} citedSources={citedSources} />
      )}

      {/* Loading shimmer: thinking block open but no main content yet */}
      {isThinking && !mainContent && null}
    </div>
  );
}

// ── Markdown + citations renderer ─────────────────────────────
//
// Strategy: split the text on [docId] citation tokens, render each
// text segment through ReactMarkdown, and insert citation chips between
// segments. This preserves markdown inside text segments while keeping
// citation chips exactly where they appear in the original content.

interface MarkdownWithCitationsProps {
  content: string;
  citedSources?: CitedSource[];
}

function MarkdownWithCitations({ content, citedSources }: MarkdownWithCitationsProps) {
  const hasAnyCitations =
    (citedSources && citedSources.length > 0) || /\[EXTRACTED\]/.test(content);

  if (!hasAnyCitations) {
    // Fast path: pure markdown, no citation processing needed
    return (
      <div className="prose prose-sm prose-invert max-w-none
        prose-p:leading-relaxed prose-p:my-1.5
        prose-headings:font-black prose-headings:tracking-tight prose-headings:text-foreground
        prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
        prose-strong:font-black prose-strong:text-foreground
        prose-em:text-muted-foreground
        prose-code:bg-muted/60 prose-code:text-secondary prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[12px] prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
        prose-pre:bg-muted/30 prose-pre:border prose-pre:border-border prose-pre:rounded-xl
        prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
        prose-blockquote:border-l-primary/30 prose-blockquote:text-muted-foreground
        prose-a:text-secondary prose-a:no-underline hover:prose-a:underline
        prose-hr:border-border"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }

  // Slow path: split on citation tokens, interleave chips + markdown segments
  const parts: React.ReactNode[] = [];
  const regex = new RegExp(CITATION_PATTERN.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let segKey = 0;

  while ((match = regex.exec(content)) !== null) {
    // Text segment before the citation
    if (match.index > lastIndex) {
      const segment = content.slice(lastIndex, match.index);
      parts.push(
        <InlineMarkdown key={`md-${segKey++}`}>{segment}</InlineMarkdown>
      );
    }

    const docId = match[1];

    // Knowledge-graph chip
    if (docId === "EXTRACTED") {
      parts.push(
        <Tooltip key={`kg-${match.index}`}>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 rounded text-[10px] font-bold uppercase tracking-wider cursor-default align-middle"
              style={{
                background: "rgba(230,185,40,0.12)",
                border: "1px solid rgba(230,185,40,0.28)",
                color: "var(--honey-600)",
              }}
            >
              <GitBranch className="w-2.5 h-2.5" />
              KG
            </span>
          </TooltipTrigger>
          <TooltipContent className="bg-black text-white border-white/10 text-xs max-w-xs">
            Extracted from knowledge graph — not a stored document
          </TooltipContent>
        </Tooltip>
      );
      lastIndex = regex.lastIndex;
      continue;
    }

    // Document citation chip
    const source = citedSources?.find((s) => s.document_id === docId);
    if (source) {
      parts.push(
        <Tooltip key={`cite-${docId}-${match.index}`}>
          <TooltipTrigger asChild>
            <span
              className="inline-flex items-center px-2 py-0.5 mx-0.5 bg-secondary/10 border border-secondary/20 rounded text-[10px] font-bold uppercase tracking-wider text-secondary cursor-pointer hover:bg-secondary/20 transition-colors align-middle"
              onClick={() => {
                if (source.external_url) {
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
              <p className="text-muted-foreground">Type: {source.source_type}</p>
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
      // Unknown docId — render as plain text
      parts.push(
        <span key={`cite-unknown-${match.index}`} className="align-middle">
          [{docId}]
        </span>
      );
    }

    lastIndex = regex.lastIndex;
  }

  // Remaining text after last citation
  if (lastIndex < content.length) {
    parts.push(
      <InlineMarkdown key={`md-${segKey++}`}>
        {content.slice(lastIndex)}
      </InlineMarkdown>
    );
  }

  return <div className="leading-relaxed text-[15px]">{parts}</div>;
}

// ── Inline markdown segment ───────────────────────────────────
// Renders a text segment (between citation chips) with markdown support.
// Uses ReactMarkdown's `unwrapDisallowed` to avoid wrapping inline content
// in block <p> tags when the segment is part of a larger inline flow.

function InlineMarkdown({ children }: { children: string }) {
  return (
    <span className="prose prose-sm prose-invert max-w-none inline
      [&_p]:inline [&_p]:m-0
      prose-strong:font-black prose-strong:text-foreground
      prose-em:text-muted-foreground
      prose-code:bg-muted/60 prose-code:text-secondary prose-code:rounded prose-code:px-1 prose-code:text-[12px] prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
      prose-a:text-secondary prose-a:no-underline hover:prose-a:underline
      prose-ul:my-1 prose-ol:my-1 prose-li:my-0"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </span>
  );
}
