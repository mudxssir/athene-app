import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { parseBody } from "@/lib/validation";

const VALID_CRON = /^(\*|[0-9,*/-]+)\s+(\*|[0-9,*/-]+)\s+(\*|[0-9,*/-]+)\s+(\*|[0-9,*/-]+)\s+(\*|[0-9,*/-]+)$/;

const CreateWatchlistSchema = z.object({
  name:             z.string().min(1).max(200).trim(),
  query:            z.string().min(1).max(2000).trim(),
  schedule:         z.string().min(1).max(100).trim().refine(
    (v) => VALID_CRON.test(v),
    { message: "schedule must be a valid 5-field cron expression (e.g. '0 */6 * * *')" }
  ),
  notify_channels:  z.array(z.object({
    type:        z.enum(["in_app", "email", "slack"]),
    destination: z.string().max(500).optional(),
  })).optional().default([{ type: "in_app" }]),
});

async function resolveInternalIds(clerkUserId: string, clerkOrgId: string) {
  const [access, orgResult] = await Promise.all([
    resolveUserAccess(clerkUserId, clerkOrgId),
    supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", clerkOrgId)
      .single(),
  ]);

  if (!access.internal_user_id) return null;
  if (!orgResult.data) return null;
  return { userId: access.internal_user_id, orgId: orgResult.data.id };
}

export async function GET(request: NextRequest) {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ids = await resolveInternalIds(clerkUserId, clerkOrgId);
  if (!ids) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { data, error } = await supabaseAdmin
    .from("watchlists")
    .select("*")
    .eq("org_id", ids.orgId)
    .eq("user_id", ids.userId)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error({ err: error.message }, "[watchlists] GET list error");
    return NextResponse.json({ error: "Failed to fetch watchlists" }, { status: 500 });
  }

  return NextResponse.json({ watchlists: data });
}

export async function POST(request: NextRequest) {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ids = await resolveInternalIds(clerkUserId, clerkOrgId);
  if (!ids) return NextResponse.json({ error: "User not found" }, { status: 403 });

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseBody(CreateWatchlistSchema, raw);
  if (!parsed.success) return parsed.response;

  const { name, query, schedule, notify_channels } = parsed.data;

  const { data, error } = await supabaseAdmin
    .from("watchlists")
    .insert({
      org_id:          ids.orgId,
      user_id:         ids.userId,
      name,
      query,
      schedule,
      notify_channels,
      is_active:       true,
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error.message }, "[watchlists] POST create error");
    return NextResponse.json({ error: "Failed to create watchlist" }, { status: 500 });
  }

  return NextResponse.json({ watchlist: data }, { status: 201 });
}
