/**
 * Delivers watchlist alert notifications across configured channels.
 *
 * Supported channels:
 *  - in_app  : inserts a row into watchlist_alerts (always done)
 *  - email   : sends via Gmail OAuth (if user has Gmail connected)
 *  - slack   : placeholder — requires Slack write capability (chat.postMessage)
 */
import { supabaseAdmin } from "@/lib/supabase/server";
import type {
  Watchlist,
  WatchlistAlert,
  DiffResult,
  EvaluationResult,
  AlertSeverity,
} from "./types";

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info:     "ℹ️",
  warning:  "⚠️",
  critical: "🚨",
};

function buildEmailBody(
  watchlist: Watchlist,
  alert: WatchlistAlert,
): string {
  const emoji = SEVERITY_EMOJI[alert.severity];
  return `
${emoji} Athene Watchlist Alert — ${alert.severity.toUpperCase()}

Watchlist: ${watchlist.name}
Query: "${watchlist.query}"

What changed:
${alert.change_summary}

Current answer:
${alert.new_answer}

${alert.cited_sources.length ? `Sources:\n${alert.cited_sources.map((s) => `• ${s.title ?? s.source_type}${s.external_url ? ` — ${s.external_url}` : ""}`).join("\n")}` : ""}

---
View in Athene: ${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.athene.ai"}/decisions
To stop receiving these alerts, edit your watchlist settings.
`.trim();
}

/** Creates the in-app alert row and returns it */
async function createInAppAlert(
  watchlist: Watchlist,
  diff: DiffResult,
  evaluation: EvaluationResult,
  previousAnswer: string | null,
): Promise<WatchlistAlert | null> {
  const { data, error } = await supabaseAdmin
    .from("watchlist_alerts")
    .insert({
      watchlist_id:     watchlist.id,
      org_id:           watchlist.org_id,
      user_id:          watchlist.user_id,
      previous_answer:  previousAnswer,
      new_answer:       evaluation.answer,
      change_summary:   diff.summary,
      severity:         diff.severity,
      cited_sources:    evaluation.cited_sources,
    })
    .select()
    .single();

  if (error) {
    console.error("[watchlist:notifier] Failed to create alert", error);
    return null;
  }
  return data as WatchlistAlert;
}

/** Sends an email alert via the user's connected Gmail account */
async function sendEmailAlert(
  watchlist: Watchlist,
  alert: WatchlistAlert,
  toAddress: string,
): Promise<void> {
  try {
    // Find the user's Gmail connection
    const { data: conn } = await supabaseAdmin
      .from("connections")
      .select("id, nango_connection_id")
      .eq("org_id", watchlist.org_id)
      .eq("user_id", watchlist.user_id)
      .eq("provider", "gmail")
      .eq("status", "active")
      .single();

    if (!conn) return; // User has no Gmail connected — skip silently

    const { sendEmail } = await import(
      "@/lib/integrations/google/gmail-fetcher"
    );

    const subject = `[Athene Alert] ${watchlist.name} — ${alert.severity.toUpperCase()}`;
    const body = buildEmailBody(watchlist, alert);

    // RFC 822 encoding
    const raw = Buffer.from(
      [
        `To: ${toAddress}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        "",
        body,
      ].join("\r\n"),
    ).toString("base64url");

    await sendEmail(conn.nango_connection_id, watchlist.org_id, raw);
  } catch (err) {
    // Non-fatal — in-app alert already created
    console.error("[watchlist:notifier] Email delivery failed", err);
  }
}

export async function deliverAlerts(
  watchlist: Watchlist,
  diff: DiffResult,
  evaluation: EvaluationResult,
  previousAnswer: string | null,
): Promise<void> {
  // Always create in-app alert
  const alert = await createInAppAlert(watchlist, diff, evaluation, previousAnswer);
  if (!alert) return;

  // Deliver to additional configured channels
  for (const channel of watchlist.notify_channels) {
    if (channel.type === "email" && channel.destination) {
      await sendEmailAlert(watchlist, alert, channel.destination);
    }
    // slack: TODO — requires adding chat.postMessage to lib/integrations/slack/client.ts
  }
}
