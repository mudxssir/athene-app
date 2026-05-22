import { NextResponse } from "next/server";
import { getContextFromHeaders, withRLS } from "@/lib/supabase/rls-client";
import { logger } from "@/lib/logger";

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const context = getContextFromHeaders(request.headers);

  if (!context) {
    return NextResponse.json({ 
      error: "Unauthorized or missing org context. Ensure you are signed into an organization." 
    }, { status: 401 });
  }

  try {
    // Demonstrate full RLS chain by running a query through the wrapper
    const result = await withRLS(context, async (supabase) => {
      // This query is now RLS-protected by the session headers set in the wrapper
      const { data: user } = await supabase
        .from('org_members')
        .select('id, org_id, role, email, display_name, created_at')
        .eq('id', context.user_id)

      const { data: org } = await supabase
        .from('organizations')
        .select('id, clerk_org_id, name, slug, created_at')
        .eq('id', context.org_id)

      return {
        profile: user?.[0] || null,
        organization: org?.[0] || null
      };
    });

    return NextResponse.json({
      message: "Full RLS chain verified.",
      context,
      data: result
    });
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, "Error in whoami route");
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
