// ============================================================
// calendar-agent.ts — Calendar Agent (ATH-38)
//
// Translates natural-language scheduling requests into a
// structured CalendarEventDraft and queues it for HITL approval.
//
// Design notes:
//     The system loads the prompt from lib/agents/prompts/calendar-draft.md.
//   • Timezone is read from state.user.timezone (BUG-01 fix).
//   • Validates create actions have start/end before queuing (BUG-02 fix).
//   • Maps action_type to the correct tool name (BUG-03 fix).
// ============================================================

import { z } from "zod";
import { resolveModelClient } from "../langgraph/llm-factory";
import type { AtheneStateType, AtheneStateUpdate } from "../langgraph/state";
import { AIMessage } from "@langchain/core/messages";
import fs from "fs";
import path from "path";
import { logger } from "@/lib/logger";
import { buildApprovalUpdate } from "../langgraph/tool-names";

// ---- Structured output schema --------------------------------

export const calendarEventSchema = z.object({
  action_type: z
    .enum(["create", "update", "delete", "search"])
    .default("create"),
  is_search: z
    .boolean()
    .default(false)
    .describe(
      "True if the user is looking for a free slot rather than a specific time"
    ),
  summary: z.string().describe("The title of the meeting"),
  start: z
    .object({
      dateTime: z.string().describe("ISO 8601 start time"),
      timeZone: z.string().describe("The timezone for this time"),
    })
    .optional(),
  end: z
    .object({
      dateTime: z.string().describe("ISO 8601 end time"),
      timeZone: z.string().describe("The timezone for this time"),
    })
    .optional(),
  search_range: z
    .object({
      startAfter: z.string().describe("ISO 8601 earliest possible time"),
      endBefore: z.string().describe("ISO 8601 latest possible time"),
    })
    .optional(),
  recurrence: z
    .string()
    .optional()
    .describe("Recurrence rule (e.g. WEEKLY;BYDAY=MO)"),
  constraints: z
    .array(z.string())
    .optional()
    .describe(
      "User constraints (e.g. ['avoid Wednesdays', 'virtual only'])"
    ),
  attendees: z
    .array(
      z
        .object({
          email: z.string().optional(),
          displayName: z.string().optional(),
        })
        .refine((data) => data.email || data.displayName, {
          message: "At least one of email or displayName must be provided",
        })
    )
    .optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  cancellation_note: z
    .string()
    .optional()
    .describe("Note if this draft replaces another event"),
});

export type CalendarEventDraft = z.infer<typeof calendarEventSchema>;

// Prompt is read from lib/agents/prompts/calendar-draft.md
const PROMPT_FILE_PATH = path.join(
  process.cwd(),
  "lib/agents/prompts/calendar-draft.md"
);

function getSystemPrompt(): string {
  try {
    return fs.readFileSync(PROMPT_FILE_PATH, "utf8");
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "[calendarAgent] Error reading prompt file");
    // Fallback to minimal prompt if file read fails
    return "You are a calendar assistant. Draft a calendar event based on the user request.";
  }
}

// ---- Agent node ---------------------------------------------

/**
 * Calendar Agent Node
 *
 * Handles complex strategic scheduling and search requests.
 * On success: returns pending_write_action + awaiting_approval=true.
 * On error:   returns a user-friendly message without crashing the graph.
 */
export async function calendarAgent(
  state: AtheneStateType
): Promise<AtheneStateUpdate> {
  const now = new Date();
  // BUG-01 FIX: Read timezone from state.user
  const timezone = state.user?.timezone || "UTC";

  const dateContext = `Current System Time: ${now.toISOString()}
User Local Time: ${now.toLocaleString("en-US", { timeZone: timezone })}
User Timezone: ${timezone}`;

  const systemPrompt = getSystemPrompt()
    .replace("{dateContext}", dateContext)
    .replace("{timezone}", timezone);

  const baseModel = await resolveModelClient("gpt-4o", state.orgId);
  const draftModel = baseModel.withStructuredOutput(calendarEventSchema, {
    name: "draft_calendar_event",
  });

  try {
    const draft = (await draftModel.invoke([
      { role: "system", content: systemPrompt },
      ...state.messages,
    ])) as CalendarEventDraft;

    // BUG-02 FIX: Draft validation before queuing
    if (draft.action_type === "create" && (!draft.start || !draft.end)) {
      return {
        messages: [
          new AIMessage({
            content: "I've drafted the meeting, but I'm missing the specific start or end time. Could you let me know when it should happen?",
          }),
        ],
      };
    }

    // Search is read-only — execute directly, no HITL needed
    if (draft.action_type === "search") {
      return {
        messages: [
          new AIMessage({
            content: `I'll search your calendar for: ${draft.summary || "the requested time range"}. Please check your calendar app for the results, or connect your calendar and ask me to look up events directly.`,
          }),
        ],
      };
    }

    // BUG-03 FIX: Dynamic tool name based on action_type
    const toolName = `calendar-${draft.action_type}`;

    return buildApprovalUpdate(toolName, draft as Record<string, unknown>);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ err: msg }, "[calendarAgent] Error");

    return {
      messages: [
        new AIMessage({
          content:
            "I'm sorry, I couldn't quite process that calendar request. Could you please provide more details about the date, time, or people involved?",
        }),
      ],
    };
  }
}
