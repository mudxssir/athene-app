// ============================================================
// GET /api/graph/edges — RLS-filtered knowledge graph edges
//
// Returns edges between a given set of node IDs.
// Query params:
//   ?nodeIds[]=<id>&nodeIds[]=<id>  — required node IDs
// ============================================================

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest) {
  try {
    const { userId, orgId, orgRole } = await auth();

    if (!userId || !orgId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const access = await resolveUserAccess(userId, orgId, orgRole);
    if (!access.internal_user_id || !access.role) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Resolve internal org UUID
    const { data: orgData } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", orgId)
      .single();

    if (!orgData) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const internalOrgId = orgData.id;

    // Parse node IDs from query params
    const { searchParams } = new URL(req.url);
    const nodeIds = searchParams.getAll("nodeIds[]");

    if (!nodeIds.length) {
      return NextResponse.json(
        { error: "Missing required param: nodeIds[]" },
        { status: 400 }
      );
    }

    // Sanitize IDs first (UUIDs only), then cap at 500
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const validIds = nodeIds.filter((id) => uuidRegex.test(id)).slice(0, 500);

    if (!validIds.length) {
      return NextResponse.json({ edges: [], total: 0 });
    }

    // CRITICAL: Verify the user can actually see these nodes (role-based visibility)
    let nodeQuery = supabaseAdmin
      .from("kg_nodes")
      .select("id")
      .eq("org_id", internalOrgId)
      .in("id", validIds);

    if (access.role === "member") {
      nodeQuery = nodeQuery.or(
        `visibility.eq.org_wide,` +
        (access.dept_id ? `department_ids.cs.{${access.dept_id}}` : `visibility.eq.org_wide`)
      );
    } else if (access.role === "super_user") {
      const deptIds = access.accessible_dept_ids ?? [];
      if (deptIds.length > 0) {
        const deptFilter = deptIds.map((id) => `department_ids.cs.{${id}}`).join(",");
        nodeQuery = nodeQuery.or(`visibility.eq.org_wide,${deptFilter}`);
      } else {
        nodeQuery = nodeQuery.eq("visibility", "org_wide");
      }
    }
    // Admins see everything

    const { data: accessibleNodes } = await nodeQuery;
    const accessibleIds = (accessibleNodes ?? []).map((n: { id: string }) => n.id);

    if (!accessibleIds.length) {
      return NextResponse.json({ edges: [], total: 0 });
    }

    // Fetch edges where both source and target are in the accessible node set.
    // Capped at 10 000 to prevent unbounded payloads on dense graphs.
    const { data: edges, error } = await supabaseAdmin
      .from("kg_edges")
      .select("*")
      .eq("org_id", internalOrgId)
      .in("source_node", accessibleIds)
      .in("target_node", accessibleIds)
      .limit(10000);

    if (error) {
      logger.error({ error: error.message }, "[graph/edges] Query failed");
      return NextResponse.json({ error: "Failed to fetch edges" }, { status: 500 });
    }

    return NextResponse.json({
      edges: edges ?? [],
      total: edges?.length ?? 0,
    });
  } catch (err) {
    logger.error({ err }, "[graph/edges] Unexpected error");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
