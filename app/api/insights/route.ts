import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { mapRole } from "@/lib/auth/clerk";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/redis/client";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

// ATH-53: Added Zod schemas for robust input validation (Recommendation #5)
const CreateInsightSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  query: z.string().min(1, "Query is required").max(2000),
});

const UpdateInsightSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  sort_order: z.number().min(0).max(10000).optional(),
  refresh: z.boolean().optional(),
});

/**
 * Verifies the caller is admin or super_user (bi_analyst).
 * Returns { userId, orgId, role } or throws.
 */
async function ensureAdminOrAnalyst() {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) throw new Error("Unauthorized");

  const role = mapRole(orgRole ?? undefined);
  if (role !== "admin" && role !== "super_user") throw new Error("Forbidden");

  return { userId, orgId, role };
}

async function resolveContext(clerkUserId: string, clerkOrgId: string) {
  const { data: orgData, error: orgError } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", clerkOrgId)
    .limit(1)
    .maybeSingle();

  if (orgError) throw orgError;
  if (!orgData) {
    logger.warn({ clerkOrgId }, "[insights] Organization context not found");
    throw new Error("Context not found");
  }

  const { data: memberData, error: memberError } = await supabaseAdmin
    .from("org_members")
    .select("id, role")
    .eq("clerk_user_id", clerkUserId)
    .eq("org_id", orgData.id)
    .limit(1)
    .maybeSingle();

  if (memberError) throw memberError;
  if (!memberData) {
    logger.warn({ clerkUserId, clerkOrgId, orgId: orgData.id }, "[insights] Member context not found");
    throw new Error("Context not found");
  }

  return {
    memberId: memberData.id,
    memberRole: memberData.role,
    orgId: orgData.id,
  };
}

/**
 * Runs the LangGraph agent to answer a BI query.
 * Returns { answer, citations } — or a safe fallback if the agent is unavailable.
 */
async function runAgentQuery(
  query: string,
  userId: string,
  orgId: string,
  role: string
): Promise<{ answer: string; citations: { title: string | null; url?: string | null }[] }> {
  try {
    // Dynamic import so that a missing SUPABASE_DB_URL doesn't crash the module
    const { getAgentGraph } = await import("@/lib/langgraph/graph");
    const graph = await getAgentGraph();

    const threadId = crypto.randomUUID();

    // ATH-53: Added 55s timeout to stay within Vercel's 60s limit
    const agentPromise = graph.invoke(
      {
        messages: [new HumanMessage(query)],
        orgId,
        userId,
        role,
        user: { id: userId, timezone: "UTC" },
        task_type: "bi_insight",
        is_cross_dept_query: true,
      },
      { configurable: { thread_id: threadId } }
    );

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Agent timeout")), 55000)
    );

    const finalState = (await Promise.race([agentPromise, timeoutPromise])) as any;

    const answer: string =
      typeof finalState.final_answer === "string"
        ? finalState.final_answer
        : finalState.final_answer?.text ??
          finalState.final_answer?.content ??
          "Agent returned no answer.";

    const citations = (finalState.cited_sources ?? []).map((s: any) => ({
      title: s.title ?? null,
      url: s.external_url ?? null,
    }));

    return { answer, citations };
  } catch (err: any) {
    logger.warn({ err: err.message }, "[insights] Agent unavailable — storing placeholder");
    return {
      answer: "Agent analysis pending. Click Refresh once the system is fully configured.",
      citations: [],
    };
  }
}

// ---------------------------------------------------------------------------
// GET /api/insights  — list all insight cards for the org
// ---------------------------------------------------------------------------
export async function GET(_req: NextRequest) {
  try {
    const { userId, orgId: clerkOrgId } = await ensureAdminOrAnalyst();
    const { orgId } = await resolveContext(userId, clerkOrgId);

    const { data, error } = await supabaseAdmin
      .from("insights")
      .select("*")
      .eq("org_id", orgId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json(data ?? []);
  } catch (err: any) {
    logger.error({ err: err.message }, "[insights] GET failed");
    if (err.message === "Unauthorized") return new NextResponse("Unauthorized", { status: 401 });
    if (err.message === "Forbidden") return new NextResponse("Forbidden", { status: 403 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/insights  — create a new insight card, call the agent
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const { userId, orgId: clerkOrgId, role } = await ensureAdminOrAnalyst();

    const { allowed } = await rateLimit(`insights:${userId}`, 30, 3600);
    if (!allowed) {
      return new NextResponse("Rate limited", { status: 429 });
    }

    const { orgId, memberId } = await resolveContext(userId, clerkOrgId);

    let body: any;
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // ATH-53: Use Zod for validation
    const result_val = CreateInsightSchema.safeParse(body);
    if (!result_val.success) {
      return NextResponse.json({ error: result_val.error.issues[0].message }, { status: 400 });
    }
    const { title, query } = result_val.data;

    // Run the cross-department agent to get an answer
    const { answer, citations } = await runAgentQuery(query, memberId, orgId, role);

    const result = { answer, citations };

    const { data, error } = await supabaseAdmin
      .from("insights")
      .insert({
        org_id: orgId,
        title,
        query,
        result,
        refreshed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      // ATH-53: Explicit error handling for lost agent results
      logger.error(
        { error: error.message, orgId, query, result },
        "[insights] POST insert failed after successful agent run"
      );
      throw error;
    }
    return NextResponse.json(data, { status: 201 });
  } catch (err: any) {
    logger.error({ err: err.message }, "[insights] POST failed");
    if (err.message === "Unauthorized") return new NextResponse("Unauthorized", { status: 401 });
    if (err.message === "Forbidden") return new NextResponse("Forbidden", { status: 403 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/insights  — refresh a card (re-runs the agent) or rename it
// ---------------------------------------------------------------------------
export async function PATCH(req: NextRequest) {
  try {
    const { userId, orgId: clerkOrgId, role } = await ensureAdminOrAnalyst();
    const { orgId, memberId } = await resolveContext(userId, clerkOrgId);

    let body: any;
    try { body = await req.json(); } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // ATH-53: Use Zod for validation
    const result_val = UpdateInsightSchema.safeParse(body);
    if (!result_val.success) {
      return NextResponse.json({ error: result_val.error.issues[0].message }, { status: 400 });
    }
    const { id, title, sort_order, refresh } = result_val.data;

    // Verify the insight belongs to this org
    const { data: existing } = await supabaseAdmin
      .from("insights")
      .select("org_id, query")
      .eq("id", id)
      .single();

    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (existing.org_id !== orgId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const patch: Record<string, unknown> = {};
    if (title?.trim()) patch.title = title.trim();
    if (typeof sort_order === "number") patch.sort_order = sort_order;

    // Re-run the agent if explicitly requested (Refresh button)
    if (refresh) {
      const { answer, citations } = await runAgentQuery(existing.query, memberId, orgId, role);
      patch.result = { answer, citations };
      patch.refreshed_at = new Date().toISOString(); // ATH-53: Only update timestamp on actual refresh
    }

    const { data, error } = await supabaseAdmin
      .from("insights")
      .update(patch)
      .eq("id", id)
      .eq("org_id", orgId)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (err: any) {
    logger.error({ err: err.message }, "[insights] PATCH failed");
    if (err.message === "Unauthorized") return new NextResponse("Unauthorized", { status: 401 });
    if (err.message === "Forbidden") return new NextResponse("Forbidden", { status: 403 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/insights?id=...  — delete a card (owner or admin only)
// ---------------------------------------------------------------------------
export async function DELETE(req: NextRequest) {
  try {
    const { userId, orgId: clerkOrgId, role } = await ensureAdminOrAnalyst();
    const { orgId, memberId } = await resolveContext(userId, clerkOrgId);

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });

    const { data: existing } = await supabaseAdmin
      .from("insights")
      .select("org_id")
      .eq("id", id)
      .single();

    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (existing.org_id !== orgId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { error } = await supabaseAdmin
      .from("insights")
      .delete()
      .eq("id", id)
      .eq("org_id", orgId);
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err: any) {
    logger.error({ err: err.message }, "[insights] DELETE failed");
    if (err.message === "Unauthorized") return new NextResponse("Unauthorized", { status: 401 });
    if (err.message === "Forbidden") return new NextResponse("Forbidden", { status: 403 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
