import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { mapRole } from "@/lib/auth/clerk";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getProviderBrowser, isBrowsable } from "@/lib/integrations/browsing";
import { logger } from "@/lib/logger";
import type { ProviderKey } from "@/lib/integrations/providers";

interface Params { params: Promise<{ id: string }> }

/**
 * GET /api/connections/[id]/browse
 *
 * Lists browsable resources for a connection so the user can
 * select which ones to sync.
 *
 * Query params:
 *   - parentId:   ID of the parent resource to list children of (optional, null = root)
 *   - parentPath: Breadcrumb path of the parent node for building full child paths (optional)
 *   - pageToken:  Pagination token from a previous response (optional)
 *   - limit:      Max number of results per page (optional, default 50)
 *
 * Admin-only. Connection ownership is verified via org_id.
 */
export async function GET(request: Request, { params }: Params) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });
  if (mapRole(orgRole ?? undefined) !== "admin") return new NextResponse("Forbidden", { status: 403 });

  const { id: connectionId } = await params;
  const url = new URL(request.url);
  const parentId = url.searchParams.get("parentId") ?? undefined;
  const parentPath = url.searchParams.get("parentPath") ?? undefined;
  const pageToken = url.searchParams.get("pageToken") ?? undefined;
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);

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

  // Load the connection and verify org ownership
  const { data: conn, error: connErr } = await supabaseAdmin
    .from("connections")
    .select("id, org_id, provider, nango_connection_id")
    .eq("id", connectionId)
    .eq("org_id", internalOrgId)
    .single();

  if (connErr || !conn) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const provider = conn.provider as ProviderKey;

  // Check if this provider supports browsing
  if (!isBrowsable(provider)) {
    return NextResponse.json({
      browsable: false,
      message: `${provider} does not support selective resource browsing. All resources will be synced.`,
      resources: [],
    });
  }

  const browser = getProviderBrowser(provider);
  if (!browser) {
    return NextResponse.json({ error: "Browser not available" }, { status: 500 });
  }

  try {
    const result = await browser(
      conn.nango_connection_id,
      internalOrgId,
      parentId,
      { pageToken, limit, parentPath }
    );

    return NextResponse.json({
      browsable: true,
      resources: result.resources,
      nextPageToken: result.nextPageToken ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, provider }, "[browse] Error browsing provider");
    return NextResponse.json(
      { error: `Failed to browse resources: ${message}` },
      { status: 500 }
    );
  }
}
