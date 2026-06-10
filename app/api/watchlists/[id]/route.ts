import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { parseBody } from "@/lib/validation";

const VALID_CRON = /^(\*|[0-9,*/-]+)\s+(\*|[0-9,*/-]+)\s+(\*|[0-9,*/-]+)\s+(\*|[0-9,*/-]+)\s+(\*|[0-9,*/-]+)$/;

const PatchWatchlistSchema = z.object({
  name:            z.string().min(1).max(200).trim().optional(),
  query:           z.string().min(1).max(2000).trim().optional(),
  schedule:        z.string().min(1).max(100).trim().refine(
    (v) => VALID_CRON.test(v),
    { message: "schedule must be a valid 5-field cron expression" }
  ).optional(),
  is_active:       z.boolean().optional(),
  notify_channels: z.array(z.object({
    type:        z.enum(["in_app", "email", "slack"]),
    destination: z.string().max(500).optional(),
  })).optional(),
});

async function resolveAndVerify(clerkUserId: string, clerkOrgId: string, watchlistId: string) {
  const [access, orgResult] = await Promise.all([
    resolveUserAccess(clerkUserId, clerkOrgId),
    supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", clerkOrgId)
      .single(),
  ]);

  if (!access.internal_user_id || !orgResult.data) return null;

  const { data: watchlist } = await supabaseAdmin
    .from("watchlists")
    .select("*")
    .eq("id", watchlistId)
    .eq("org_id", orgResult.data.id)
    .eq("user_id", access.internal_user_id)
    .single();

  if (!watchlist) return null;
  return { userId: access.internal_user_id, orgId: orgResult.data.id, watchlist };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await resolveAndVerify(clerkUserId, clerkOrgId, id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: alerts } = await supabaseAdmin
    .from("watchlist_alerts")
    .select("*")
    .eq("watchlist_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ watchlist: result.watchlist, alerts: alerts ?? [] });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await resolveAndVerify(clerkUserId, clerkOrgId, id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseBody(PatchWatchlistSchema, raw);
  if (!parsed.success) return parsed.response;

  const { data, error } = await supabaseAdmin
    .from("watchlists")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error.message, id }, "[watchlists] PATCH error");
    return NextResponse.json({ error: "Failed to update watchlist" }, { status: 500 });
  }

  return NextResponse.json({ watchlist: data });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await resolveAndVerify(clerkUserId, clerkOrgId, id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error } = await supabaseAdmin
    .from("watchlists")
    .delete()
    .eq("id", id)
    .eq("org_id", result.orgId)
    .eq("user_id", result.userId);

  if (error) {
    logger.error({ err: error.message, id }, "[watchlists] DELETE error");
    return NextResponse.json({ error: "Failed to delete watchlist" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
