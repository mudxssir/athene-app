// ============================================================
// GET /api/graph/timeline — decisions applied to a given entity
//
// Returns all decision nodes that have an APPLIED_TO edge pointing
// to the given entity label, ordered chronologically.
//
// Query params:
//   ?entity=<label>   — required; the project/service/process label
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

    const { data: orgData } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", orgId)
      .single();

    if (!orgData) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const entityLabel = searchParams.get("entity");

    if (!entityLabel) {
      return NextResponse.json({ error: "Missing required param: entity" }, { status: 400 });
    }

    const internalOrgId = orgData.id;

    // Find the target node by label (case-insensitive exact match).
    // Escape ilike wildcard chars so a label like "50% growth" doesn't
    // become a pattern match catching unrelated nodes.
    const sanitizedLabel = entityLabel.replace(/[%_\\]/g, '\\$&')
    const { data: targetNode } = await supabaseAdmin
      .from("kg_nodes")
      .select("id, label")
      .eq("org_id", internalOrgId)
      .ilike("label", sanitizedLabel)
      .limit(1)
      .maybeSingle();

    if (!targetNode) {
      return NextResponse.json({
        entity: entityLabel,
        decisions: [],
      });
    }

    // Find all APPLIED_TO edges where target = this node
    const { data: edges } = await supabaseAdmin
      .from("kg_edges")
      .select("source_node")
      .eq("org_id", internalOrgId)
      .eq("target_node", targetNode.id)
      .eq("relation", "APPLIED_TO");

    if (!edges?.length) {
      return NextResponse.json({
        entity: targetNode.label,
        decisions: [],
      });
    }

    const sourceIds = edges.map((e) => e.source_node);

    // Fetch the decision nodes, ordered chronologically
    const { data: decisions, error } = await supabaseAdmin
      .from("kg_nodes")
      .select("id, label, description, temporal_metadata, created_at")
      .eq("org_id", internalOrgId)
      .eq("entity_type", "decision")
      .in("id", sourceIds)
      .order("temporal_metadata->occurred_at", { ascending: true, nullsFirst: true });

    if (error) {
      logger.error({ err: error.message, entity: entityLabel, org_id: internalOrgId }, "[api/graph/timeline] Supabase error");
      return NextResponse.json({ error: "Query failed" }, { status: 500 });
    }

    return NextResponse.json({
      entity: targetNode.label,
      decisions: decisions ?? [],
    });
  } catch (err) {
    logger.error({ err }, "[api/graph/timeline] Unexpected error");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
