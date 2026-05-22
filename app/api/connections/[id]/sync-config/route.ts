import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { mapRole } from "@/lib/auth/clerk";
import { supabaseAdmin } from "@/lib/supabase/server";
import { validateSyncConfig, parseSyncConfig } from "@/lib/integrations/sync-config";
import { logger } from "@/lib/logger";

interface Params { params: Promise<{ id: string }> }

/**
 * GET /api/connections/[id]/sync-config
 *
 * Returns the current sync configuration for a connection.
 * Admin-only. Connection ownership is verified via org_id.
 */
export async function GET(_request: Request, { params }: Params) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });
  if (mapRole(orgRole ?? undefined) !== "admin") return new NextResponse("Forbidden", { status: 403 });

  const { id: connectionId } = await params;

  // Resolve Clerk orgId → internal UUID
  const { data: orgData, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", orgId)
    .maybeSingle();

  if (orgErr || !orgData) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const internalOrgId = orgData.id as string;

  const { data: conn, error: connErr } = await supabaseAdmin
    .from("connections")
    .select("id, sync_config")
    .eq("id", connectionId)
    .eq("org_id", internalOrgId)
    .single();

  if (connErr || !conn) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // Normalize raw JSONB → typed SyncConfig (handles legacy empty objects)
  const config = parseSyncConfig(conn.sync_config);

  return NextResponse.json({ syncConfig: config });
}

/**
 * PUT /api/connections/[id]/sync-config
 *
 * Updates the sync configuration for a connection.
 * Optionally triggers a re-sync if `triggerSync` is true.
 * Admin-only. Connection ownership is verified via org_id.
 */
export async function PUT(request: Request, { params }: Params) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });
  if (mapRole(orgRole ?? undefined) !== "admin") return new NextResponse("Forbidden", { status: 403 });

  const { id: connectionId } = await params;

  let body: { syncConfig: unknown; triggerSync?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate the sync config
  const validationError = validateSyncConfig(body.syncConfig);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  // Resolve Clerk orgId → internal UUID
  const { data: orgData, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", orgId)
    .maybeSingle();

  if (orgErr || !orgData) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const internalOrgId = orgData.id as string;

  // Verify connection ownership
  const { data: conn, error: connErr } = await supabaseAdmin
    .from("connections")
    .select("id, provider, source_type, department_id, nango_connection_id")
    .eq("id", connectionId)
    .eq("org_id", internalOrgId)
    .single();

  if (connErr || !conn) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // Stamp the config with a timestamp
  const configToSave = {
    ...(body.syncConfig as object),
    lastConfiguredAt: new Date().toISOString(),
  };

  // Update the sync_config column
  const { error: updateErr } = await supabaseAdmin
    .from("connections")
    .update({ sync_config: configToSave })
    .eq("id", connectionId);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Optionally trigger a re-sync
  let dispatched = false;
  if (body.triggerSync) {
    try {
      const { dispatchThrottled } = await import("@/lib/qstash/client");
      const workerUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/worker/nango-fetch`;
      const result = await dispatchThrottled({
        orgId: internalOrgId,
        sourceType: conn.source_type,
        url: workerUrl,
        body: {
          orgId: internalOrgId,
          connectionId,
          nangoConnectionId: conn.nango_connection_id,  // Nango string — for provider API calls
          provider: conn.provider,
          sourceType: conn.source_type,
          departmentId: conn.department_id ?? null,
        },
      });
      dispatched = result.dispatched;
    } catch (err: unknown) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "[sync-config] Failed to dispatch re-sync");
    }
  }

  return NextResponse.json({
    success: true,
    syncConfig: configToSave,
    dispatched,
  });
}
