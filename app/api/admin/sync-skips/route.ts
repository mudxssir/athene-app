// ============================================================
// GET /api/admin/sync-skips — skipped-content telemetry (P0-5)
//
// Surfaces what the ingestion pipeline refused to index and why
// (skip-sentinels, unsupported binaries), so silent data loss is
// visible to admins. Read-only; rows are written by background
// workers via service role.
// ============================================================

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
import { logger } from "@/lib/logger";

export async function GET(request: Request) {
  try {
    const { userId, orgId, orgRole } = await auth();
    if (!userId || !orgId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const access = await resolveUserAccess(userId, orgId, orgRole);
    if (access.role !== "admin" || !access.internal_org_id || !access.internal_user_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);

    const ctx: RLSContext = {
      org_id: access.internal_org_id,
      user_id: access.internal_user_id,
      department_id: access.dept_id ?? undefined,
      user_role: access.role,
    };

    const skips = await withRLS(ctx, async (supabase) => {
      const { data, error } = await supabase
        .from("sync_skips")
        .select("id, connection_id, external_id, title, reason, first_seen, last_seen")
        .order("last_seen", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`sync_skips read failed: ${error.message}`);
      return data ?? [];
    });

    return NextResponse.json({ skips, count: skips.length });
  } catch (error: unknown) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "[admin/sync-skips] GET Error"
    );
    return NextResponse.json({ error: "Failed to load sync skips" }, { status: 500 });
  }
}
