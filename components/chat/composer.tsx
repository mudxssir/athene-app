"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ── Scope filters ─────────────────────────────────────────────────────────────
const SCOPES = ["All sources", "Customer data", "Internal docs", "My team"] as const;
type Scope = typeof SCOPES[number];

interface ComposerProps {
  onSend: (message: string, scope?: Scope) => void;
  isLoading?: boolean;
  isAnalytical?: boolean;
  placeholder?: string;
  /** Pre-populate the input (e.g. from reference card "Ask →" buttons).
   *  Changing either field focuses the textarea and sets its content.
   *  Use prefillSeq as an incrementing counter to force re-trigger even
   *  when the same string is sent twice in a row. */
  prefillValue?: string;
  prefillSeq?: number;
}

const MAX_LENGTH = 10000;

export function Composer({
  onSend,
  isLoading = false,
  isAnalytical = false,
  placeholder = "Ask Athene to synthesize anything...",
  prefillValue,
  prefillSeq,
}: ComposerProps) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeScope, setActiveScope] = useState<Scope>("All sources");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // When a reference card sets a prefill, populate input and focus composer.
  // prefillSeq is an incrementing counter so the effect fires even when the
  // same string is sent twice in a row.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!prefillValue) return;
    setInput(prefillValue);
    setError(null);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
      el.focus();
      el.selectionStart = el.selectionEnd = el.value.length;
    }, 0);
  // prefillSeq is the trigger — intentionally omitting prefillValue from deps
  // so we don't double-apply when seq changes but value stays the same.
  }, [prefillSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function sendMessage() {
    const message = input.trim();
    if (!message || isLoading) return;

    if (message.length > MAX_LENGTH) {
      setError(`Message exceeds maximum length of ${MAX_LENGTH.toLocaleString()} characters.`);
      return;
    }

    setError(null);
    onSend(message, activeScope);
    setInput("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setInput(value);
    if (value.length > MAX_LENGTH) {
      setError(`Message exceeds maximum length of ${MAX_LENGTH.toLocaleString()} characters.`);
    } else {
      setError(null);
    }
    // Auto-resize textarea
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }

  const charCount = input.length;
  const isNearLimit = charCount > MAX_LENGTH * 0.9;

  return (
    <div className="bg-card p-[10px_12px_10px_18px] rounded-[32px] border border-border flex flex-col gap-2 shadow-[var(--shadow-3)] relative z-10 mx-6 mb-4 group focus-within:border-primary/40 transition-all">

      {/* ── Scope filter chips ─────────────────────────────── */}
      <div className="flex items-center gap-2 px-2 pt-1 flex-wrap">
        {SCOPES.map((scope) => {
          const active = scope === activeScope;
          return (
            <button
              key={scope}
              type="button"
              onClick={() => setActiveScope(scope)}
              style={{
                display: "inline-flex", alignItems: "center", minHeight: 30,
                padding: "0 12px", borderRadius: 999,
                fontFamily: "var(--font-sans)", fontWeight: 800,
                fontSize: 10, letterSpacing: "0.22em", textTransform: "uppercase",
                border: active ? "1px solid rgba(160,74,27,0.35)" : "1px solid var(--border)",
                background: active ? "rgba(160,74,27,0.10)" : "transparent",
                color: active ? "var(--primary)" : "var(--fg-subtle)",
                cursor: "pointer", transition: "all .15s ease",
              }}
            >
              {scope}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="px-4 text-xs text-red-400 font-medium">
          {error}
        </div>
      )}
      <div className="flex items-end gap-4">
        <div className="flex-1 flex items-end gap-4">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            placeholder={isAnalytical ? "Synthesize department-wide BI patterns..." : placeholder}
            className="flex-1 bg-transparent border-none focus:outline-none text-foreground text-[15px] font-medium placeholder:text-muted-foreground/20 placeholder:font-bold placeholder:uppercase placeholder:tracking-widest resize-none min-h-[48px] max-h-[200px] py-3"
            rows={1}
            maxLength={MAX_LENGTH}
          />

          <div className="flex items-center gap-3 pr-2 shrink-0">
            {/* Lavender disruptor — the one "yellow shoes" button on this page */}
            <Button
              onClick={sendMessage}
              disabled={isLoading || !input.trim()}
              className="btn-lav h-11 w-11 rounded-full disabled:bg-muted disabled:text-muted-foreground shadow-[var(--shadow-2)] transition-all active:scale-95 flex items-center justify-center"
            >
              {isLoading ? (
                <Loader2 className="w-6 h-6 animate-spin" />
              ) : (
                <Send className="w-6 h-6" />
              )}
            </Button>
          </div>
        </div>
      </div>
      {isNearLimit && (
        <div className={`px-4 text-xs font-medium ${charCount > MAX_LENGTH ? "text-red-400" : "text-yellow-400"}`}>
          {charCount}/{MAX_LENGTH.toLocaleString()} characters
        </div>
      )}
    </div>
  );
}
