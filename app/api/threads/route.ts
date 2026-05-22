import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/redis/client";
import { parseBody } from "@/lib/validation";

const ThreadPostSchema = z.object({
  title: z.string().min(1).max(300).trim().optional(),
});

/**
 * GET /api/threads
 * List threads for the authenticated user in their current org.
 */
export async function GET(request: NextRequest) {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const access = await resolveUserAccess(clerkUserId, clerkOrgId);
  if (!access.internal_user_id) {
    return NextResponse.json({ error: "User not found in organization" }, { status: 403 });
  }

  // Resolve internal org UUID from Clerk org ID
  const { data: orgData } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", clerkOrgId)
    .single();

  if (!orgData) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin
    .from("threads")
    .select("id, title, last_message_at, message_count, created_at")
    .eq("org_id", orgData.id)
    .eq("user_id", access.internal_user_id)
    .order("updated_at", { ascending: false });

  if (error) {
    logger.error({ err: error.message, org_id: orgData.id }, "[threads] GET error");
    return NextResponse.json({ error: "Failed to fetch threads" }, { status: 500 });
  }

  return NextResponse.json({ threads: data });
}

/**
 * POST /api/threads
 * Create a new conversation thread.
 * Body: { title?: string }
 */
export async function POST(request: NextRequest) {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 60 thread creations per user per hour
  const { allowed } = await rateLimit(`threads:post:${clerkUserId}`, 60, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });

  const access = await resolveUserAccess(clerkUserId, clerkOrgId);
  if (!access.internal_user_id) {
    return NextResponse.json({ error: "User not found in organization" }, { status: 403 });
  }

  // Resolve internal org UUID
  const { data: orgData, error: orgError } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", clerkOrgId)
    .single();

  if (orgError || !orgData) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  let title: string | undefined;
  try {
    const rawBody = await request.json();
    const parsed = parseBody(ThreadPostSchema, rawBody);
    if (!parsed.success) return parsed.response;
    title = parsed.data.title;
  } catch {
    // empty body is valid — title is optional
  }

  const { data, error } = await supabaseAdmin
    .from("threads")
    .insert({
      org_id: orgData.id,
      user_id: access.internal_user_id,
      title: title ?? null,
    })
    .select("id, title, last_message_at, message_count, created_at")
    .single();

  if (error) {
    logger.error({ err: error.message, org_id: orgData.id }, "[threads] POST error");
    return NextResponse.json({ error: "Failed to create thread" }, { status: 500 });
  }

  return NextResponse.json({ thread: data });
}
