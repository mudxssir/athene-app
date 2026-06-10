import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { evaluateWatchlist } from "@/lib/watchlists/evaluator";
import { diffAnswers } from "@/lib/watchlists/differ";
import { deliverAlerts } from "@/lib/watchlists/notifier";
import { loadUserContext } from "@/lib/watchlists/context";
import type { Watchlist } from "@/lib/watchlists/types";

export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [access, orgResult] = await Promise.all([
    resolveUserAccess(clerkUserId, clerkOrgId),
    supabaseAdmin.from("organizations").select("id").eq("clerk_org_id", clerkOrgId).single(),
  ]);

  if (!access.internal_user_id) {
    return NextResponse.json({ error: "User not found" }, { status: 403 });
  }
  const orgData = orgResult.data;
  if (!orgData) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: watchlist } = await supabaseAdmin
    .from("watchlists")
    .select("*")
    .eq("id", id)
    .eq("org_id", orgData.id)
    .eq("user_id", access.internal_user_id)
    .single();

  if (!watchlist) return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });

  const ctx = await loadUserContext(orgData.id, access.internal_user_id);
  if (!ctx) return NextResponse.json({ error: "Could not load user context" }, { status: 500 });

  let evaluation;
  try {
    evaluation = await evaluateWatchlist(watchlist.id, watchlist.query, ctx);
  } catch (err) {
    logger.error({ err, id }, "[watchlists/run] Evaluation failed");
    return NextResponse.json({ error: "Evaluation failed" }, { status: 500 });
  }

  const diff = await diffAnswers(
    watchlist.last_answer,
    watchlist.last_answer_hash,
    evaluation.answer,
    evaluation.answer_hash,
    orgData.id,
  );

  if (diff.changed) {
    await deliverAlerts(watchlist as Watchlist, diff, evaluation, watchlist.last_answer);
  }

  await supabaseAdmin
    .from("watchlists")
    .update({
      last_run_at:        new Date().toISOString(),
      last_answer:        evaluation.answer,
      last_answer_hash:   evaluation.answer_hash,
      last_cited_sources: evaluation.cited_sources,
    })
    .eq("id", id);

  return NextResponse.json({
    success:  true,
    changed:  diff.changed,
    severity: diff.severity,
    answer:   evaluation.answer,
  });
}
