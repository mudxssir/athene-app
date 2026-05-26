// ============================================================
// agents/email-agent.ts — Email Agent LangGraph node (ATH-37)
//
// Drafts an email from the user's request + retrieved context.
// NEVER sends — sets pending_write_action so the HITL gate
// (ATH-43) pauses execution until the human approves.
//
// The LLM extracts { to, cc, subject, body } as JSON.
// Real email addresses are resolved from retrieved_chunks
// (CRM contacts, directory data, etc.) — never guessed.
// ============================================================

import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { resolveModelClient } from "../langgraph/llm-factory";
import type { AtheneState, AtheneStateUpdate } from "../langgraph/state";
import { TOOL_NAMES, buildApprovalUpdate } from "../langgraph/tool-names";
import { logger } from "../logger";


// ---- Prompt (inlined at build time, no fs.readFileSync) ------

const SYSTEM_PROMPT = `You are the Athene AI Email Drafting Agent.

Your job is to compose a professional email based on the user's request and the retrieved context.

## Rules

1. Return ONLY a valid JSON object — no markdown fences, no commentary.
2. Extract the recipient's real email address from the retrieved context. If no email address is found in context, set "to" to an empty array and add "_warning": "Could not resolve recipient email from context".
3. Never invent or guess email addresses. Every address in "to" and "cc" must come from the retrieved context or the user's explicit input.
4. Keep the subject concise (< 80 chars).
5. Write a professional, friendly body appropriate for a workplace setting.
6. Preserve any specific details the user mentioned (dates, times, topics).

## Output Schema

{
  "to": ["recipient@company.com"],
  "cc": [],
  "subject": "Clear, concise subject line",
  "body": "Professional email body."
}`;

// ---- Helpers -------------------------------------------------

/** Build the full prompt with conversation + retrieved context */
function buildPrompt(state: AtheneState): string {
  const history = state.messages
    .map((m) => {
      const role = m instanceof HumanMessage ? "human" : m instanceof AIMessage ? "assistant" : "tool";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${role}: ${content}`;
    })
    .join("\n");

  const context = state.retrieved_chunks
    .map((c) => c.content_preview)
    .join("\n\n");

  return [
    SYSTEM_PROMPT,
    "",
    "## Conversation History",
    history,
    "",
    "## Retrieved Context",
    context || "(no context retrieved)",
    "",
    "Draft the email now. Return only the JSON object.",
  ].join("\n");
}

/** Extract JSON from LLM output, handling markdown fences */
function parseEmailDraft(raw: string): {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  _warning?: string;
} {
  const fallback = { to: [], cc: [], subject: "", body: "" };

  let text = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(text);
    return {
      to: Array.isArray(parsed.to) ? parsed.to : [],
      cc: Array.isArray(parsed.cc) ? parsed.cc : [],
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      _warning: typeof parsed._warning === "string" ? parsed._warning : undefined,
    };
  } catch {
    logger.error({ text: text.slice(0, 200) }, "[email-agent] Failed to parse LLM JSON");
    return fallback;
  }
}

// ---- Node function -------------------------------------------

export async function emailAgentNode(
  state: AtheneState,
): Promise<AtheneStateUpdate> {
  const prompt = buildPrompt(state);

  const llm = await resolveModelClient("medium", state.orgId);

  const response = await llm.invoke([
    { role: "system", content: prompt },
    { role: "user", content: "Draft the email based on my request." },
  ]);

  const rawResponse =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  const draft = parseEmailDraft(rawResponse);

  // ATH-37: Validate draft before triggering HITL gate.
  // If the draft is completely empty or missing basic fields, we don't trigger approval.
  const hasContent = draft.to.length > 0 || draft.subject.trim() || draft.body.trim();

  if (!hasContent) {
    return {
      run_status: "failed",
      messages: [
        new AIMessage({
          content: "I'm sorry, I was unable to generate a valid email draft. Please ensure there is enough context (like a recipient name or email) in the conversation.",
        }),
      ],
    };
  }

  // Set pending_write_action and pause for HITL approval.
  // The graph's interrupt_before: ["approval_node"] will halt
  // execution before the approval_node runs.
  return buildApprovalUpdate(TOOL_NAMES.EMAIL_SEND, draft);
}
