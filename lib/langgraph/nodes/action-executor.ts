// FROZEN (REFOCUS §3.1/§3.2): not wired into graph routing — the assistant is
// read-only in Phase 1. Kept intact for reversibility; unfreeze via WRITE_ACTIONS_ENABLED.
// ============================================================
// nodes/action-executor.ts — Executes approved write actions
//
// This node runs AFTER an action has been approved by a human.
// It reads pending_write_action from state, dispatches to the
// appropriate integration, and stores the result or error.
// ============================================================

import { AIMessage } from "@langchain/core/messages";
import type { AtheneState, AtheneStateUpdate, PendingWriteAction } from "../state";
import { sendEmail as sendMicrosoftEmail } from "@/lib/integrations/microsoft/outlook-fetcher";
import type { EmailDraft as MicrosoftEmailDraft } from "@/lib/integrations/microsoft/outlook-fetcher";
import { createEvent as createMicrosoftEvent } from "@/lib/integrations/microsoft/calendar-fetcher";
import type { EventDraft as MicrosoftEventDraft } from "@/lib/integrations/microsoft/calendar-fetcher";
import { sendEmail as sendGoogleEmail } from "@/lib/integrations/google/gmail-fetcher";
import { createCalendarEvent as createGoogleEvent } from "@/lib/integrations/google/calendar-fetcher";
import type { EventDraft as GoogleEventDraft } from "@/lib/integrations/google/calendar-fetcher";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { recordHitlApprovalDuration, incrementHitlDecision } from "@/lib/telemetry/metrics";
import { TOOL_NAMES } from "../tool-names";

const MS_PROVIDER_KEY = "microsoft";
const GOOGLE_PROVIDER_KEY = "google";

/** Default timeout for external integration calls (30 seconds). */
const INTEGRATION_TIMEOUT_MS = 30_000;

/**
 * Race a promise against a timeout. If the timeout fires first, the returned
 * promise rejects with a descriptive error so the agent state always receives
 * actionable feedback instead of hanging forever.
 */
function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms: number = INTEGRATION_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Integration timeout: ${label} did not respond within ${ms / 1000}s. ` +
          `The external provider may be down — please retry later.`
        )
      );
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Resolves an active connection for the organization, prioritizing providers
 * that support the requested tool.
 */
async function resolveConnection(
  orgId: string,
  tool: string
): Promise<{ connectionId: string; provider: string }> {
  // Specific providers are preferred over generic ones (e.g. "gmail" beats "google"
  // which might be a Drive connection that happens to match the "google" key).
  const specificCandidates = tool.startsWith("email")
    ? ["gmail", "outlook"]
    : ["google_calendar", "ms_calendar"];

  const genericCandidates = tool.startsWith("email")
    ? [GOOGLE_PROVIDER_KEY, MS_PROVIDER_KEY]
    : [GOOGLE_PROVIDER_KEY, MS_PROVIDER_KEY];

  for (const candidates of [specificCandidates, genericCandidates]) {
    const { data, error } = await supabaseAdmin
      .from("nango_connections")
      .select("connection_id, provider_config_key")
      .eq("org_id", orgId)
      .in("provider_config_key", candidates)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      throw new Error(`Failed to resolve connections: ${error.message}`);
    }

    if (data && data.length > 0) {
      return {
        connectionId: data[0].connection_id,
        provider: data[0].provider_config_key,
      };
    }
  }

  throw new Error(`No active connections (Google/Microsoft) found for this organization`);
}

// ─── Microsoft Mappers ────────────────────────────────────────────────────────

function toMicrosoftEmailDraft(payload: Record<string, unknown>): MicrosoftEmailDraft {
  const to = Array.isArray(payload.to) ? payload.to.filter((value): value is string => typeof value === "string") : [];
  const cc = Array.isArray(payload.cc) ? payload.cc.filter((value): value is string => typeof value === "string") : [];
  const subject = typeof payload.subject === "string" ? payload.subject : "";
  const body = typeof payload.body === "string" ? payload.body : "";

  if (to.length === 0) {
    throw new Error("Approved email draft is missing recipients");
  }

  return {
    subject,
    body: {
      contentType: "Text",
      content: body,
    },
    toRecipients: to.map((address) => ({
      emailAddress: { address },
    })),
    ccRecipients: cc.map((address) => ({
      emailAddress: { address },
    })),
  };
}

function toMicrosoftEventDraft(payload: Record<string, unknown>): MicrosoftEventDraft {
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const description = typeof payload.description === "string" ? payload.description : undefined;
  const location = typeof payload.location === "string" ? payload.location : undefined;
  const start = payload.start as { dateTime?: unknown; timeZone?: unknown } | undefined;
  const end = payload.end as { dateTime?: unknown; timeZone?: unknown } | undefined;
  const attendees = Array.isArray(payload.attendees)
    ? payload.attendees.filter((attendee): attendee is { email?: unknown; displayName?: unknown } => typeof attendee === "object" && attendee !== null)
    : [];

  if (!summary || !start?.dateTime || !start?.timeZone || !end?.dateTime || !end?.timeZone) {
    throw new Error("Approved calendar draft is missing required event fields");
  }

  return {
    subject: summary,
    body: description
      ? {
          contentType: "Text",
          content: description,
        }
      : undefined,
    start: {
      dateTime: String(start.dateTime),
      timeZone: String(start.timeZone),
    },
    end: {
      dateTime: String(end.dateTime),
      timeZone: String(end.timeZone),
    },
    location: location ? { displayName: location } : undefined,
    attendees: attendees
      .filter((attendee) => typeof attendee.email === "string" && attendee.email.length > 0)
      .map((attendee) => ({
        emailAddress: {
          address: String(attendee.email),
          name: typeof attendee.displayName === "string" ? attendee.displayName : String(attendee.email),
        },
        type: "required" as const,
      })),
  };
}

// ─── Google Mappers ───────────────────────────────────────────────────────────

function toGoogleEmailDraft(payload: Record<string, unknown>): string {
  const to = Array.isArray(payload.to) ? payload.to.filter((value): value is string => typeof value === "string") : [];
  const cc = Array.isArray(payload.cc) ? payload.cc.filter((value): value is string => typeof value === "string") : [];
  const subject = typeof payload.subject === "string" ? payload.subject : "";
  const body = typeof payload.body === "string" ? payload.body : "";

  if (to.length === 0) {
    throw new Error("Approved email draft is missing recipients");
  }

  // Build RFC 822 message
  const lines = [
    `To: ${to.join(", ")}`,
    cc.length > 0 ? `Cc: ${cc.join(", ")}` : null,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].filter((l) => l !== null);

  const raw = lines.join("\r\n");

  // Base64url encode
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function toGoogleEventDraft(payload: Record<string, unknown>): GoogleEventDraft {
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  const description = typeof payload.description === "string" ? payload.description : undefined;
  const location = typeof payload.location === "string" ? payload.location : undefined;
  const start = payload.start as { dateTime?: unknown; timeZone?: unknown } | undefined;
  const end = payload.end as { dateTime?: unknown; timeZone?: unknown } | undefined;
  const attendees = Array.isArray(payload.attendees)
    ? payload.attendees.filter((attendee): attendee is { email?: unknown } => typeof attendee === "object" && attendee !== null)
    : [];

  if (!summary || !start?.dateTime || !end?.dateTime) {
    throw new Error("Approved calendar draft is missing required event fields");
  }

  return {
    summary,
    description,
    location,
    start: {
      dateTime: String(start.dateTime),
      timeZone: typeof start.timeZone === "string" ? start.timeZone : undefined,
    },
    end: {
      dateTime: String(end.dateTime),
      timeZone: typeof end.timeZone === "string" ? end.timeZone : undefined,
    },
    attendees: attendees
      .filter((a) => typeof a.email === "string")
      .map((a) => ({ email: String(a.email) })),
  };
}

export async function actionExecutorNode(
  state: AtheneState
): Promise<AtheneStateUpdate> {
  const action = state.pending_write_action as PendingWriteAction | null;

  if (!action) {
    return {
      run_status: "running",
      awaiting_approval: false,
    };
  }

  // Record HITL approval metrics
  const requestedAt = action.requested_at;
  if (requestedAt) {
    const pendingMs = Date.now() - new Date(requestedAt).getTime();
    recordHitlApprovalDuration(pendingMs, { tool: action.tool });
  }
  incrementHitlDecision({ decision: "approved", tool: action.tool });

  // ── Integration tools ─────────────────────────────────────────────────────
  // Handled before resolveConnection() — that helper is email/calendar-specific
  // and would throw for these tool names.

  if (action.tool === TOOL_NAMES.INTEGRATION_CONNECT) {
    // The OAuth popup was completed by the frontend before the user clicked Approve.
    // The connection is already saved in nango_connections by /api/admin/integrations.
    // Nothing to execute server-side — just confirm and resume the graph.
    const displayName = typeof action.payload?.displayName === "string"
      ? action.payload.displayName
      : "The integration";
    logger.info(
      { orgId: state.orgId, provider: action.payload?.provider },
      "[action-executor] integration-connect approved",
    );
    return {
      action_result: { success: true, provider: action.payload?.provider },
      action_error: null,
      pending_write_action: null,
      awaiting_approval: false,
      run_status: "running",
      messages: [new AIMessage({
        content: `✓ **${displayName}** connected successfully. Your documents will begin syncing in the background — ask me "sync status" anytime to check progress.`,
      })],
    };
  }

  if (action.tool === TOOL_NAMES.INTEGRATION_DISCONNECT) {
    const { connectionId, provider, displayName } = (action.payload ?? {}) as Record<string, string>;
    if (!connectionId || !provider) {
      logger.error(
        { orgId: state.orgId, payload: action.payload },
        "[action-executor] integration-disconnect missing connectionId or provider",
      );
      return {
        action_result: null,
        action_error: "Missing connection details in disconnect payload",
        pending_write_action: null,
        awaiting_approval: false,
        run_status: "running",
        messages: [new AIMessage({
          content: "I couldn't complete the disconnection — connection details were missing. Please try again.",
        })],
      };
    }

    try {
      const { deleteConnection } = await import("@/lib/nango/client");
      await withTimeout(
        deleteConnection(connectionId, provider, state.orgId),
        "integration-disconnect",
      );
      logger.info(
        { orgId: state.orgId, provider, connectionId },
        "[action-executor] integration-disconnect completed",
      );
      return {
        action_result: { success: true, provider },
        action_error: null,
        pending_write_action: null,
        awaiting_approval: false,
        run_status: "running",
        messages: [new AIMessage({
          content: `✓ **${displayName ?? provider}** disconnected. All indexed documents from this source have been removed.`,
        })],
      };
    } catch (err) {
      logger.error(
        { orgId: state.orgId, provider, err: err instanceof Error ? err.message : String(err) },
        "[action-executor] integration-disconnect failed",
      );
      return {
        action_result: null,
        action_error: err instanceof Error ? err.message : String(err),
        pending_write_action: null,
        awaiting_approval: false,
        run_status: "running",
        messages: [new AIMessage({
          content: `I couldn't disconnect **${displayName ?? provider}**. Please try again or remove it from the integrations page.`,
        })],
      };
    }
  }

  // ── Email / Calendar tools ────────────────────────────────────────────────

  try {
    let result: unknown;
    const { connectionId, provider } = await withTimeout(
      resolveConnection(state.orgId, action.tool),
      "Connection lookup"
    );

    switch (action.tool) {
      case TOOL_NAMES.EMAIL_SEND: {
        if (provider === MS_PROVIDER_KEY || provider === "outlook") {
          result = await withTimeout(
            sendMicrosoftEmail(
              connectionId,
              state.orgId,
              toMicrosoftEmailDraft(action.payload)
            ),
            "email-send (microsoft)"
          );
        } else {
          result = await withTimeout(
            sendGoogleEmail(
              connectionId,
              state.orgId,
              toGoogleEmailDraft(action.payload)
            ),
            "email-send (google)"
          );
        }
        break;
      }
      case TOOL_NAMES.CALENDAR_CREATE: {
        if (provider === MS_PROVIDER_KEY || provider === "ms_calendar") {
          result = await withTimeout(
            createMicrosoftEvent(
              connectionId,
              state.orgId,
              toMicrosoftEventDraft(action.payload)
            ),
            "calendar-create (microsoft)"
          );
        } else {
          result = await withTimeout(
            createGoogleEvent(
              connectionId,
              state.orgId,
              toGoogleEventDraft(action.payload)
            ),
            "calendar-create (google)"
          );
        }
        break;
      }
      default:
        throw new Error(`Unknown action tool: ${action.tool}`);
    }

    return {
      action_result: result,
      action_error: null,
      pending_write_action: null,
      awaiting_approval: false,
      run_status: "running",
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, tool: action.tool, orgId: state.orgId }, "[action-executor] Execution failed");
    return {
      action_result: null,
      action_error: errMsg,
      pending_write_action: null,
      awaiting_approval: false,
      run_status: "running",
      messages: [new AIMessage({
        content: `✗ The action was approved but failed to execute: ${errMsg}`,
      })],
    };
  }
}
