import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/redis/client";
import { parseBody } from "@/lib/validation";

const WorkflowPostSchema = z.object({
  name:   z.string().min(1).max(200).trim(),
  config: z.record(z.string(), z.unknown()),
});

export async function POST(req: NextRequest) {
  try {
    const { userId, orgId } = await auth();
    if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });

    // Rate limit: 30 workflow saves per user per hour
    const { allowed } = await rateLimit(`workflows:post:${userId}`, 30, 3600);
    if (!allowed) return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });

    let raw: unknown;
    try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsed = parseBody(WorkflowPostSchema, raw);
    if (!parsed.success) return parsed.response;
    const { name, config } = parsed.data;

    // Resolve internal org and user
    const { data: orgRow } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", orgId)
      .single();

    if (!orgRow) return NextResponse.json({ error: "Organization not found" }, { status: 404 });

    const { data: memberRow } = await supabaseAdmin
      .from("org_members")
      .select("id")
      .eq("clerk_user_id", userId)
      .eq("org_id", orgRow.id)
      .single();

    if (!memberRow) return NextResponse.json({ error: "User not found in organization" }, { status: 403 });

    // Use existing 'automations' table to store workflow config
    // Using upsert since there is a UNIQUE (org_id, user_id, type) constraint
    const { data, error } = await supabaseAdmin
      .from("automations")
      .upsert({
        org_id: orgRow.id,
        user_id: memberRow.id,
        type: "workflow",
        config: { name, nodes: config },
        status: "active",
        updated_at: new Date().toISOString(),
      }, { onConflict: "org_id,user_id,type" })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data);
  } catch (error: any) {
    logger.error({ err: error?.message ?? String(error) }, "[workflows] POST Error");
    return NextResponse.json({ error: "Workflow save failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { userId, orgId } = await auth();
    if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });

    const { data: orgRow } = await supabaseAdmin
      .from("organizations")
      .select("id")
      .eq("clerk_org_id", orgId)
      .single();

    if (!orgRow) return NextResponse.json({ error: "Organization not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin
      .from("automations")
      .select("*")
      .eq("org_id", orgRow.id)
      .eq("type", "workflow")
      .order("updated_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json(data);
  } catch (error: any) {
    logger.error({ err: error?.message ?? String(error) }, "[workflows] GET Error");
    return NextResponse.json({ error: "Failed to fetch workflows" }, { status: 500 });
  }
}
