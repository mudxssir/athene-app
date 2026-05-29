import { supabaseAdmin } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/integrations/google/gmail-fetcher";
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

    if (!conn) return;

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

  const emailChannels = watchlist.notify_channels.filter(
    (c) => c.type === "email" && c.destination,
  );
  await Promise.all(
    emailChannels.map((c) => sendEmailAlert(watchlist, alert, c.destination!)),
  );
}
