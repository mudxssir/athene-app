import { auth, clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { invalidateRBACCache, resolveUserAccess } from "@/lib/auth/rbac";

// Internal role → Clerk org role (inverse of mapRole in lib/auth/clerk.ts)
const INTERNAL_TO_CLERK_ROLE: Record<string, string> = {
  admin: "org:admin",
  member: "org:member",
  super_user: "org:bi_analyst",
};


/**
 * PATCH /api/admin/users/[id]
 * Updates user role, department, or active status.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId, orgId, orgRole } = await auth();
  const { id: targetMemberId } = await params;

  if (!userId || !orgId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // 1. Resolve internal access (respects 'active' flag)
  const access = await resolveUserAccess(userId, orgId, orgRole);
  if (access.role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }


  try {
    const { role: newRole, departmentId, active } = await request.json();

    // 2. Resolve internal org UUID
    const { data: orgData } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", orgId)
      .single();

    if (!orgData) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }


    // 3. Fetch current state for audit
    const { data: currentMember, error: fetchError } = await supabaseAdmin
      .from("org_members")
      .select("*")
      .eq("id", targetMemberId)
      .eq("org_id", orgData.id)
      .single();

    if (fetchError || !currentMember) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // 4. Resolve internal UUID for the admin performing the action
    const { data: adminMember } = await supabaseAdmin
      .from("org_members")
      .select("id")
      .eq("clerk_user_id", userId)
      .eq("org_id", orgData.id)
      .single();

    // 5. Self-deactivation guard
    if (adminMember?.id === targetMemberId && active === false) {
      return NextResponse.json({ error: "You cannot deactivate your own account" }, { status: 400 });
    }

    // 6. Update Supabase
    const updates: Partial<{
      role: "admin" | "super_user" | "member";
      department_id: string;
      active: boolean;
    }> = {};
    if (newRole !== undefined) updates.role = newRole;
    if (departmentId !== undefined) updates.department_id = departmentId;
    if (active !== undefined) updates.active = active;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }


    const { data: updatedMember, error: updateError } = await supabaseAdmin
      .from("org_members")
      .update(updates)
      .eq("id", targetMemberId)
      .select()
      .single();

    if (updateError) throw updateError;

    // 7. Sync role change to Clerk (Clerk is auth source-of-truth — must stay in sync)
    if (newRole !== undefined && newRole !== currentMember.role && updatedMember.clerk_user_id) {
      const clerkRole = INTERNAL_TO_CLERK_ROLE[newRole];
      if (clerkRole) {
        try {
          const client = await clerkClient();
          await client.organizations.updateOrganizationMembership({
            organizationId: orgId,
            userId: updatedMember.clerk_user_id,
            role: clerkRole,
          });
        } catch (clerkErr: any) {
          logger.error(
            { err: clerkErr.message, targetClerkUserId: updatedMember.clerk_user_id, orgId, newRole },
            "[admin-users] Clerk role sync failed — DB updated but Clerk role may diverge"
          );
        }
      }
    }

    // 8. Invalidate RBAC Cache
    if (updatedMember.clerk_user_id) {
      await invalidateRBACCache(updatedMember.clerk_user_id, orgId);
    }

    // 9. Determine action name for audit log
    let action = "update_user";
    if (newRole !== undefined && newRole !== currentMember.role) action = "change_role";
    if (active === false && currentMember.active === true) action = "deactivate_user";
    if (active === true && currentMember.active === false) action = "reactivate_user";

    // 10. Audit Log (Security-sensitive actions should always be logged)
    await supabaseAdmin.from("admin_actions").insert({
      org_id: orgData.id,
      admin_user_id: adminMember?.id || null, // Fallback to null if adminMember missing (e.g. system action)
      action: action,
      target_user_id: targetMemberId,
      details: {
        before: { role: currentMember.role, department_id: currentMember.department_id, active: currentMember.active },
        after: updates,
      },
    });


    return NextResponse.json({ success: true, member: updatedMember });

  } catch (err: any) {
    logger.error({ err: err.message, orgId, targetMemberId }, "[admin-users] PATCH failed");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }

}
