// ============================================================
// GET /api/admin/media-queue — media caption queue health (P5)
//
// Surfaces the image caption queue depth by status + recent skip/fail reasons,
// so an admin can see captioning progress and any silent-drop-free skips
// (audit D12). Read-only via RLS (media_queue_admin_read policy); rows are
// written by the caption worker via service role. Mirrors /admin/sync-skips.
// ============================================================

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { withRLS, type RLSContext } from "@/lib/supabase/rls-client";
import { rateLimit } from "@/lib/redis/client";
import { logger } from "@/lib/logger";

type Depth = Record<string, number>;

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

    const { allowed } = await rateLimit(`admin:media-queue:${orgId}`, 300, 3600);
    if (!allowed) {
      return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });
    }

    const url = new URL(request.url);
    const sampleLimit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    const ctx: RLSContext = {
      org_id: access.internal_org_id,
      user_id: access.internal_user_id,
      department_id: access.dept_id ?? undefined,
      user_role: access.role,
    };

    const { depth, recent } = await withRLS(ctx, async (supabase) => {
      // Queue depth by status (aggregate client-side; the queue is small per org).
      const { data: statuses, error: sErr } = await supabase
        .from("media_queue")
        .select("status");
      if (sErr) throw new Error(`media_queue status read failed: ${sErr.message}`);
      const d: Depth = {};
      for (const r of (statuses ?? []) as Array<{ status: string }>) {
        d[r.status] = (d[r.status] ?? 0) + 1;
      }

      // Recent terminal skip/fail reasons (D12 audit trail).
      const { data: rows, error: rErr } = await supabase
        .from("media_queue")
        .select("source_doc_id, origin, status, skip_reason, updated_at")
        .in("status", ["skipped", "failed", "deferred"])
        .order("updated_at", { ascending: false })
        .limit(sampleLimit);
      if (rErr) throw new Error(`media_queue recent read failed: ${rErr.message}`);
      return { depth: d, recent: rows ?? [] };
    });

    return NextResponse.json({ depth, recent, count: recent.length });
  } catch (error: unknown) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "[admin/media-queue] GET Error"
    );
    return NextResponse.json({ error: "Failed to load media queue" }, { status: 500 });
  }
}
