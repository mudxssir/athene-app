import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listConnections, saveConnectionMapping } from "@/lib/nango/client";
import { mapRole } from "@/lib/auth/clerk";
import { supabaseAdmin } from "@/lib/supabase/server";
import { dispatchThrottled } from "@/lib/qstash/client";
import { invalidatePromptCache } from "@/lib/knowledge-graph/modules/resolver";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/redis/client";
import { parseBody, uuidSchema } from "@/lib/validation";

const ConnectionPostSchema = z.object({
  nangoConnectionId: z.string().min(1).max(255),
  provider:          z.string().min(1).max(100),
  sourceType:        z.string().min(1).max(100),
  departmentId:      uuidSchema.nullable().optional(),
  scope:             z.string().max(50).optional(),
  syncConfig:        z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/connections
 * Create a new connection record and immediately dispatch an indexing job.
 * Admin-only.
 */
export async function POST(request: Request) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });
  if (mapRole(orgRole ?? undefined) !== "admin") return new NextResponse("Forbidden", { status: 403 });

  // Rate limit: 20 new connections per org per hour to prevent abuse
  const { allowed } = await rateLimit(`connections:post:${orgId}`, 20, 3600);
  if (!allowed) return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = parseBody(ConnectionPostSchema, raw);
  if (!parsed.success) return parsed.response;
  const { nangoConnectionId, provider, sourceType, departmentId, scope, syncConfig } = parsed.data;

  // Bug 1 fix: resolve Clerk orgId → internal UUID (connections.org_id is a uuid FK to organizations.id)
  const { data: orgData, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", orgId)
    .maybeSingle();

  if (orgErr || !orgData) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const internalOrgId = orgData.id as string;

  // Insert the connection record using internal UUID
  const { data: conn, error: insertError } = await supabaseAdmin
    .from("connections")
    .insert({
      org_id: internalOrgId,
      nango_connection_id: nangoConnectionId,
      provider: provider.toLowerCase(),
      source_type: sourceType.toLowerCase(),
      scope: scope ?? "org",
      department_id: departmentId ?? null,
      sync_config: syncConfig ?? {},
      status: "active",
    })
    .select("id")
    .single();

  if (insertError || !conn) {
    return NextResponse.json({ error: insertError?.message ?? "Insert failed" }, { status: 500 });
  }

  // Bug 2 fix: record mapping in nango_connections so getConnectionToken() ownership check passes
  try {
    await saveConnectionMapping(internalOrgId, nangoConnectionId, provider);
  } catch (mappingErr: any) {
    logger.warn({ err: mappingErr.message }, '[connections/post] saveConnectionMapping failed (non-fatal)');
  }

  // Invalidate the cached extraction prompt — active modules may have changed.
  // Fire-and-forget but log failures so they appear in telemetry.
  invalidatePromptCache(internalOrgId).catch((err: unknown) =>
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[connections/post] prompt cache invalidation failed (non-fatal)')
  );

  // Providers that require user file/table selection before first sync
  // Providers that require the user to select resources before a first sync can run.
  // Adding a provider here suppresses the auto-dispatch on initial connect so the user
  // goes through the resource browser first.
  // 'github' requires repo selection — no owner/repo in Nango metadata at connect time.
  const CONFIGURABLE_PROVIDERS = new Set(['google_drive', 'snowflake', 'bigquery', 'redshift', 'github']);
  const requiresConfiguration = CONFIGURABLE_PROVIDERS.has(provider.toLowerCase());

  let dispatched = false;
  if (!requiresConfiguration) {
    // Auto-dispatch only for providers that don't need upfront configuration
    const workerUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/worker/nango-fetch`;
    ({ dispatched } = await dispatchThrottled({
      orgId: internalOrgId,
      sourceType,
      url: workerUrl,
      body: { orgId: internalOrgId, connectionId: conn.id, nangoConnectionId, provider, sourceType, departmentId: departmentId ?? null },
    }));
  }

  return NextResponse.json({
    success: true,
    connectionId: conn.id,
    internalConnectionId: conn.id,
    indexing: dispatched,
    requiresConfiguration,
  });
}

/**
 * GET /api/connections
 * 🔒 SECURE CONNECTIONS ENDPOINT (Final Clean Version)
 * Strictly enforces Clerk Organization membership and Admin role.
 */
export async function GET() {
  const { userId, orgId, orgRole } = await auth();

  if (!userId || !orgId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const role = mapRole(orgRole ?? undefined);
  if (role !== "admin") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    // nango_connections.org_id stores internal UUIDs (saved by POST handler with internalOrgId).
    // Must resolve Clerk orgId → internal UUID before querying.
    const { data: orgData, error: orgLookupErr } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", orgId)
      .maybeSingle();

    if (orgLookupErr || !orgData) {
      return NextResponse.json({ success: false, error: "Organization not found" }, { status: 404 });
    }

    const connections = await listConnections(orgData.id);

    return NextResponse.json({
      success: true,
      data: connections,
      orgId: orgId
    });

  } catch (err: any) {
    logger.error({ err: err?.message }, '[connections/get] Error fetching connections');
    
    // ✅ AUDIT CHECK: Robust error signaling (401/403/500)
    return NextResponse.json(
      {
        success: false,
        error: "Internal Server Error",
        reason: err.reason || 'UNEXPECTED_FAILURE',
        reconnect_required: !!err.reconnect_required
      },
      { status: err.status || 500 }
    );
  }
}
