/**
 * Watchlist worker — runs on a cron schedule.
 *
 * For each active watchlist whose schedule matches the current time:
 *  1. Load the user's run context (orgId, role, deptId, timezone).
 *  2. Evaluate the query via the LangGraph agent.
 *  3. Diff the new answer against the stored answer.
 *  4. If changed, create an alert and deliver notifications.
 *  5. Update watchlist with new answer + last_run_at.
 *
 * Not wired to a route yet — call runWatchlistWorker() from an API worker route.
 */
import cronstrue from "cronstrue";
import { supabaseAdmin } from "@/lib/supabase/server";
import { evaluateWatchlist, hashAnswer } from "./evaluator";
import { diffAnswers } from "./differ";
import { deliverAlerts } from "./notifier";
import type { Watchlist, WatchlistRunContext } from "./types";

/** Returns true if a cron expression matches the current UTC minute */
function cronMatchesNow(cronExpr: string): boolean {
  try {
    // Dynamic import to avoid bundling cron-parser in client builds
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CronExpressionParser } = require("cron-schedule");
    const interval = CronExpressionParser.parse(cronExpr, { timezone: "UTC" });
    const now = new Date();
    // Check if any execution falls within the current minute
    const prev = interval.getPrevDate();
    return Math.abs(now.getTime() - prev.getTime()) < 60_000;
  } catch {
    return false;
  }
}

async function loadRunContext(
  watchlist: Watchlist,
): Promise<WatchlistRunContext | null> {
  const { data: member } = await supabaseAdmin
    .from("org_members")
    .select("role, department_id, users(timezone)")
    .eq("org_id", watchlist.org_id)
    .eq("user_id", watchlist.user_id)
    .single();

  if (!member) return null;

  return {
    orgId:         watchlist.org_id,
    userId:        watchlist.user_id,
    role:          member.role,
    deptId:        member.department_id ?? null,
    userTimezone:  (member.users as any)?.timezone ?? "UTC",
  };
}

async function processWatchlist(watchlist: Watchlist): Promise<void> {
  const ctx = await loadRunContext(watchlist);
  if (!ctx) {
    console.warn(`[watchlist:worker] No context for watchlist ${watchlist.id}`);
    return;
  }

  let evaluation;
  try {
    evaluation = await evaluateWatchlist(watchlist.id, watchlist.query, ctx);
  } catch (err) {
    console.error(`[watchlist:worker] Evaluation failed for ${watchlist.id}`, err);
    // Record the failed run time so we don't retry in the same minute
    await supabaseAdmin
      .from("watchlists")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", watchlist.id);
    return;
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

  console.info(
    `[watchlist:worker] ${watchlist.id} — changed=${diff.changed} severity=${diff.severity}`,
  );
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

  // Filter to those whose cron schedule fires now (or all, if called manually)
  const due = watchlists.filter((w: Watchlist) => cronMatchesNow(w.schedule));

  let alerted = 0;
  let errors = 0;

  await Promise.allSettled(
    due.map(async (w: Watchlist) => {
      try {
        const prevHash = w.last_answer_hash;
        await processWatchlist(w);
        // Re-fetch to check if an alert was created
        const { data: updated } = await supabaseAdmin
          .from("watchlists")
          .select("last_answer_hash")
          .eq("id", w.id)
          .single();
        if (updated?.last_answer_hash !== prevHash) alerted++;
      } catch {
        errors++;
      }
    }),
  );

  return { processed: due.length, alerted, errors };
}

/** Run all active watchlists regardless of schedule (for manual triggers / testing) */
export async function runAllWatchlists(): Promise<void> {
  const { data: watchlists } = await supabaseAdmin
    .from("watchlists")
    .select("*")
    .eq("is_active", true);

  if (!watchlists?.length) return;
  await Promise.allSettled(watchlists.map((w: Watchlist) => processWatchlist(w)));
}
