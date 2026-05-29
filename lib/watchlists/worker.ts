import { supabaseAdmin } from "@/lib/supabase/server";
import { evaluateWatchlist } from "./evaluator";
import { diffAnswers } from "./differ";
import { deliverAlerts } from "./notifier";
import { loadUserContext } from "./context";
import type { Watchlist } from "./types";

const WORKER_CONCURRENCY = 5;

/**
 * Minimal 5-field cron matcher (min hour dom month dow).
 * Returns true if the expression matches the current UTC minute.
 * Supports * and comma-separated values; no ranges or steps.
 */
function cronMatchesNow(cronExpr: string): boolean {
  try {
    const fields = cronExpr.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const [min, hour, dom, month, dow] = fields;
    const now = new Date();
    const matches = (field: string, value: number) =>
      field === "*" || field.split(",").map(Number).includes(value);
    return (
      matches(min,   now.getUTCMinutes()) &&
      matches(hour,  now.getUTCHours()) &&
      matches(dom,   now.getUTCDate()) &&
      matches(month, now.getUTCMonth() + 1) &&
      matches(dow,   now.getUTCDay())
    );
  } catch {
    return false;
  }
}

/** Returns true if an alert was created (answer changed materially) */
async function processWatchlist(watchlist: Watchlist): Promise<boolean> {
  const ctx = await loadUserContext(watchlist.org_id, watchlist.user_id);
  if (!ctx) {
    console.warn(`[watchlist:worker] No context for watchlist ${watchlist.id}`);
    return false;
  }

  let evaluation;
  try {
    evaluation = await evaluateWatchlist(watchlist.id, watchlist.query, ctx);
  } catch (err) {
    console.error(`[watchlist:worker] Evaluation failed for ${watchlist.id}`, err);
    await supabaseAdmin
      .from("watchlists")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", watchlist.id);
    return false;
  }

  const diff = await diffAnswers(
    watchlist.last_answer,
    watchlist.last_answer_hash,
    evaluation.answer,
    evaluation.answer_hash,
    ctx.orgId,
  );

  if (diff.changed) {
    await deliverAlerts(watchlist, diff, evaluation, watchlist.last_answer);
  }

  await supabaseAdmin
    .from("watchlists")
    .update({
      last_run_at:        new Date().toISOString(),
      last_answer:        evaluation.answer,
      last_answer_hash:   evaluation.answer_hash,
      last_cited_sources: evaluation.cited_sources,
    })
    .eq("id", watchlist.id);

  console.info(`[watchlist:worker] ${watchlist.id} — changed=${diff.changed} severity=${diff.severity}`);
  return diff.changed;
}

export async function runWatchlistWorker(): Promise<{
  processed: number;
  alerted: number;
  errors: number;
}> {
  const { data: watchlists, error } = await supabaseAdmin
    .from("watchlists")
    .select("*")
    .eq("is_active", true);

  if (error) throw new Error(`Failed to load watchlists: ${error.message}`);
  if (!watchlists?.length) return { processed: 0, alerted: 0, errors: 0 };

  const due = (watchlists as Watchlist[]).filter((w) => cronMatchesNow(w.schedule));

  let alerted = 0;
  let errors = 0;

  for (let i = 0; i < due.length; i += WORKER_CONCURRENCY) {
    const batch = due.slice(i, i + WORKER_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((w) => processWatchlist(w)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) alerted++;
      if (r.status === "rejected") errors++;
    }
  }

  return { processed: due.length, alerted, errors };
}

export async function runAllWatchlists(): Promise<void> {
  const { data: watchlists } = await supabaseAdmin
    .from("watchlists")
    .select("*")
    .eq("is_active", true);

  if (!watchlists?.length) return;

  for (let i = 0; i < watchlists.length; i += WORKER_CONCURRENCY) {
    const batch = (watchlists as Watchlist[]).slice(i, i + WORKER_CONCURRENCY);
    await Promise.allSettled(batch.map((w) => processWatchlist(w)));
  }
}
