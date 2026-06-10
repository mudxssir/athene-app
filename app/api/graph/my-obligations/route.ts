// GET /api/graph/my-obligations — personal obligations for the signed-in user (REFOCUS §6.2)

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
import { getMyObligations } from "@/lib/knowledge-graph/my-obligations";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const { userId, orgId, orgRole } = await auth();
    if (!userId || !orgId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const access = await resolveUserAccess(userId, orgId, orgRole);
    if (!access.internal_user_id || !access.internal_org_id || !access.role) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const ctx: RLSContext = {
      org_id: access.internal_org_id,
      user_id: access.internal_user_id,
      department_id: access.dept_id ?? undefined,
      user_role: access.role,
    };

    const member = await withRLS(ctx, async (supabase) => {
      const { data, error } = await supabase
        .from("org_members")
        .select("display_name, email")
        .eq("id", access.internal_user_id!)
        .maybeSingle();
      if (error) throw new Error(`member lookup failed: ${error.message}`);
      return data;
    });

    const result = await getMyObligations(ctx, {
      displayName: member?.display_name ?? null,
      email: member?.email ?? null,
    });

    return NextResponse.json(result);
  } catch (error: any) {
    logger.error(
      { err: error?.message ?? String(error) },
      "[graph/my-obligations] GET error"
    );
    return NextResponse.json({ error: "Failed to load obligations" }, { status: 500 });
  }
}
