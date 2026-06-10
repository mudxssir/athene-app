import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
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

  const unreadOnly = request.nextUrl.searchParams.get("unread") === "true";

  let query = supabaseAdmin
    .from("watchlist_alerts")
    .select("*, watchlists(name)")
    .eq("org_id", orgData.id)
    .eq("user_id", access.internal_user_id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (unreadOnly) query = query.eq("is_read", false);

  const { data, error } = await query;

  if (error) {
    logger.error({ err: error.message }, "[watchlists/alerts] GET error");
    return NextResponse.json({ error: "Failed to fetch alerts" }, { status: 500 });
  }

  return NextResponse.json({ alerts: data ?? [], unread_count: unreadOnly ? (data?.length ?? 0) : undefined });
}
