import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { mapRole } from "@/lib/auth/clerk";
import { supabaseAdmin } from "@/lib/supabase/server";
import { dispatchThrottled } from "@/lib/qstash/client";
import { rateLimit } from "@/lib/redis/client";

interface Params { params: Promise<{ id: string }> }

/**
 * POST /api/connections/[id]/sync
 * Manually trigger a re-sync for a connection.
 * Passing { force: true } clears the sync_cursor so a full re-sync runs.
 * Admin-only.
 */
export async function POST(request: Request, { params }: Params) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });
  if (mapRole(orgRole ?? undefined) !== "admin") return new NextResponse("Forbidden", { status: 403 });

  // Rate limit: 10 manual sync triggers per org per hour (each dispatches a
  // full fetch worker — too many would flood QStash and exhaust concurrency slots)
  const { allowed } = await rateLimit(`connections:sync:${orgId}`, 10, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });

  const { id: connectionId } = await params;

  let force = false;
  try {
    const body = await request.json();
    force = !!body?.force;
  } catch { /* body optional */ }

  // Resolve Clerk orgId → internal UUID (connections.org_id is internal UUID FK)
  const { data: orgData } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", orgId)
    .maybeSingle();

  if (!orgData) return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  const internalOrgId = orgData.id as string;

  // Load connection and verify org ownership using internal UUID
  const { data: conn, error } = await supabaseAdmin
    .from("connections")
    .select("id, org_id, provider, source_type, department_id, nango_connection_id")
    .eq("id", connectionId)
    .eq("org_id", internalOrgId)
    .single();

  if (error || !conn) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // Clear cursor if force=true so full re-index runs
  if (force) {
    await supabaseAdmin
      .from("connections")
      .update({ sync_cursor: null })
      .eq("id", connectionId);
  }

  const workerUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/worker/nango-fetch`;
  const { dispatched, msgId } = await dispatchThrottled({
    orgId: internalOrgId,
    sourceType: conn.source_type,
    url: workerUrl,
    body: {
      orgId: internalOrgId,
      connectionId,
      nangoConnectionId: conn.nango_connection_id,
      provider: conn.provider,
      sourceType: conn.source_type,
      departmentId: conn.department_id ?? null,
    },
  });

  // Only mark syncing after a confirmed dispatch — avoids status getting stuck
  // when QStash is down. Queued (throttled) jobs update status when they run.
  if (dispatched) {
    await supabaseAdmin.from("connections").update({ status: "syncing" }).eq("id", connectionId);
  }

  // success mirrors dispatched — a queued-but-not-sent job is not a success
  return NextResponse.json({ success: dispatched, dispatched, msgId: msgId ?? null, force });
}
