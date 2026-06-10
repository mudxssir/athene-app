import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export async function PATCH(
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

  const { data, error } = await supabaseAdmin
    .from("watchlist_alerts")
    .update({ is_read: true })
    .eq("id", id)
    .eq("org_id", orgData.id)
    .eq("user_id", access.internal_user_id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error.message, id }, "[watchlists/alerts] PATCH error");
    return NextResponse.json({ error: "Failed to update alert" }, { status: 500 });
  }

  return NextResponse.json({ alert: data });
}
