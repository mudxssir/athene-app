import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/redis/client";
import { parseBody, emailSchema, uuidSchema, internalRoleSchema } from "@/lib/validation";

const UserInviteSchema = z.object({
  email: emailSchema,
  role: internalRoleSchema,
  departmentId: uuidSchema,
});


/**
 * GET /api/admin/users
 * Lists members for the current organization.
 */
export async function GET(request: Request) {
  const { userId, orgId, orgRole } = await auth();

  if (!userId || !orgId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // 1. Resolve internal access (respects 'active' flag)
  const access = await resolveUserAccess(userId, orgId, orgRole);
  if (access.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }


  const { searchParams } = new URL(request.url);
  // Clamp and validate pagination params to prevent negative offsets or unbounded fetches
  const rawPage  = parseInt(searchParams.get("page")  ?? "1",  10);
  const rawLimit = parseInt(searchParams.get("limit") ?? "50", 10);
  const page  = Math.max(1,   isNaN(rawPage)  ? 1  : rawPage);
  const limit = Math.min(200, Math.max(1, isNaN(rawLimit) ? 50 : rawLimit));
  const offset = (page - 1) * limit;
  // Cap search length to prevent oversized ilike queries
  const search = (searchParams.get("search") ?? "").slice(0, 200);


  try {
    // 2. Resolve internal org UUID
    const { data: orgData } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", orgId)
      .limit(1)
      .maybeSingle();

    if (!orgData) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }


    // 3. Fetch members with department info
    let query = supabaseAdmin
      .from("org_members")
      .select(`
        id,
        clerk_user_id,
        email,
        display_name,
        role,
        active,
        last_active_at,
        department_id,
        departments ( id, name )
      `, { count: "exact" })
      .eq("org_id", orgData.id);

    if (search) {
      // Escape ilike wildcard chars to prevent accidental pattern injection
      const sanitizedSearch = search.replace(/[%_\\]/g, '\\$&')
      query = query.or(`display_name.ilike.%${sanitizedSearch}%,email.ilike.%${sanitizedSearch}%`);
    }

    const { data: members, error, count } = await query
      .range(offset, offset + limit - 1)
      .order("created_at", { ascending: false });


    if (error) throw error;

    return NextResponse.json({
      users: members,
      total: count ?? 0,
      page,
      limit
    });


  } catch (err: any) {
    logger.error({ err: err.message, orgId }, "[admin-users] GET failed");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * POST /api/admin/users
 * Invites a new user to the organization.
 */
export async function POST(request: Request) {
  const { userId, orgId, orgRole } = await auth();

  if (!userId || !orgId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // 1. Resolve internal access (respects 'active' flag)
  const access = await resolveUserAccess(userId, orgId, orgRole);
  if (access.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Rate limit: 20 user invitations per org per hour
  const { allowed } = await rateLimit(`admin:invite:${orgId}`, 20, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = parseBody(UserInviteSchema, raw);
  if (!parsed.success) return parsed.response;
  const { email, role: targetRole, departmentId } = parsed.data;

  try {
    // 2. Resolve internal org UUID
    const { data: orgData } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", orgId)
      .limit(1)
      .maybeSingle();

    if (!orgData) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }


    // 3. Send invitation via Clerk

    const client = await clerkClient();
    const invitation = await client.organizations.createOrganizationInvitation({
      organizationId: orgId,
      emailAddress: email,
      role: targetRole === "admin" ? "org:admin" : targetRole === "super_user" ? "org:bi_analyst" : "org:member",
      inviterUserId: userId,
    });

    // 4. Create placeholder in org_members

    // We don't have a clerk_user_id yet, but we have the email.
    // The user will be linked when they accept the invite.
    // However, the request says "inserts row in org_members with department + role".
    const { data: newMember, error: memberError } = await supabaseAdmin
      .from("org_members")
      .insert({
        org_id: orgData.id,
        email: email,
        role: targetRole,
        department_id: departmentId,
        display_name: email.split("@")[0],
      })
      .select()
      .limit(1)
      .maybeSingle();

    if (memberError) throw memberError;
    
    // 5. Resolve internal UUID for the admin performing the action

    const { data: adminMember } = await supabaseAdmin
      .from("org_members")
      .select("id")
      .eq("clerk_user_id", userId)
      .eq("org_id", orgData.id)
      .limit(1)
      .maybeSingle();

    // 6. Audit Log

    if (adminMember) {
      await supabaseAdmin.from("admin_actions").insert({
        org_id: orgData.id,
        admin_user_id: adminMember.id,
        action: "invite_user",
        target_user_id: newMember.id,
        details: { email, role: targetRole, departmentId },
      });
    }

    // Return only display-safe fields — the raw Clerk invitation object and
    // internal member row contain tokens and org UUIDs the client doesn't need.
    return NextResponse.json({ success: true, email: parsed.data.email });

  } catch (err: any) {
    logger.error({ err: err.message, orgId }, "[admin-users] POST failed");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }

}
