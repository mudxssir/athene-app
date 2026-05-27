import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { mapRole } from "@/lib/auth/clerk";
import { supabaseAdmin } from "@/lib/supabase/server";
import { redis } from "@/lib/redis/client";

export const ABORT_KEY_PREFIX = "sync:abort:";
export const abortKey = (connectionId: string) => `${ABORT_KEY_PREFIX}${connectionId}`;

interface Params { params: Promise<{ id: string }> }

/**
 * POST /api/connections/[id]/abort
 * Signals the running sync worker to stop after the current file.
 * The worker polls this Redis key between files and exits cleanly when set.
 * Status is set to 'active' with metadata.sync_paused = true on abort.
 * A subsequent sync (Force Sync / Resume) clears the paused flag.
 */
export async function POST(_req: Request, { params }: Params) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });
  if (mapRole(orgRole ?? undefined) !== "admin") return new NextResponse("Forbidden", { status: 403 });

  const { id: connectionId } = await params;

  const { data: orgData } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", orgId)
    .maybeSingle();
  if (!orgData) return NextResponse.json({ error: "Organization not found" }, { status: 404 });

  const { data: conn } = await supabaseAdmin
    .from("connections")
    .select("id, status")
    .eq("id", connectionId)
    .eq("org_id", orgData.id)
    .maybeSingle();
  if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  if (conn.status !== "syncing") {
    return NextResponse.json({ error: "Connection is not currently syncing" }, { status: 409 });
  }

  // Redis abort signal — worker polls this between files. TTL = 1 hour so it
  // self-clears if the worker already crashed before it could check.
  await redis.set(abortKey(connectionId), "1", { ex: 3600 });

  return NextResponse.json({ ok: true });
}
