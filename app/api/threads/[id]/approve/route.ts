// ============================================================
// POST /api/threads/[id]/approve — HITL approval endpoint (ATH-43)
//
// Accepts: { action: 'approve'|'edit'|'reject', edits?: object }
//
// Flow:
//   1. Authenticate via Clerk
//   2. Verify the caller owns the thread
//   3. Validate the request body
//   4. Log the decision to hitl_decisions
//   5. Update the graph checkpoint state with the decision
//   6. Resume the graph so approval_node executes
//
// Rule #4: No writes without explicit human approval.
// ============================================================

import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import {
  processDecision,
  logHitlDecision,
  validatePayload,
  type HitlRequest,
} from "@/lib/graph/interrupts";
import { getAgentGraph } from "@/lib/langgraph/graph";
import { logger } from "@/lib/logger";
import { z } from "zod";


// ---- Route handler -------------------------------------------

const hitlRequestSchema = z.object({
  action: z.enum(["approve", "edit", "reject"]),
  edits: z.record(z.string(), z.unknown()).optional(),
}).refine(data => data.action !== "edit" || (data.edits && Object.keys(data.edits).length > 0), {
  message: "Edit action requires a non-empty edits object",
  path: ["edits"],
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // 1. Authenticate
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();

  if (!clerkUserId || !clerkOrgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Resolve internal user ID and org
  const access = await resolveUserAccess(clerkUserId, clerkOrgId);
  if (!access.internal_user_id) {
    return NextResponse.json(
      { error: "User not found in organization" },
      { status: 403 },
    );
  }

  const { id: threadId } = await params;

  // H1/M2 Fix: Validate threadId is a UUID to prevent DB cast errors
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    return NextResponse.json({ error: "Invalid thread ID format" }, { status: 400 });
  }

  // 3. Parse and validate request body
  let body: HitlRequest;
  try {
    const rawBody = await request.json();
    body = hitlRequestSchema.parse(rawBody);
  } catch (err: any) {
    return NextResponse.json(
      { error: err instanceof z.ZodError ? err.issues[0].message : "Invalid request body" },
      { status: 400 },
    );
  }

  // 4. Get the current graph state and verify thread ownership.
  const graph = await getAgentGraph();

  const currentState = await graph.getState({
    configurable: { thread_id: threadId },
  });

  if (!currentState?.values) {
    return NextResponse.json(
      { error: "No graph state found for this thread" },
      { status: 404 },
    );
  }

  const stateValues = currentState.values as Record<string, unknown>;
  
  // H1 Fix: Check ownership using internal UUIDs (since state now stores them) 
  // but ensure audit logs use consistent internal IDs.
  if (stateValues.orgId !== access.internal_org_id || stateValues.userId !== access.internal_user_id) {
    return NextResponse.json(
      { error: "Thread not found or you are not the owner" },
      { status: 403 },
    );
  }

  const pendingAction = stateValues.pending_write_action as {
    tool: string;
    payload: Record<string, unknown>;
    requested_at: string;
  } | null;

  if (!pendingAction) {
    return NextResponse.json(
      { error: "No pending action to approve" },
      { status: 409 },
    );
  }
  
  // 5. Validate payload if editing
  if (body.action === "edit") {
    try {
      const mergedPayload = { ...pendingAction.payload, ...body.edits };
      await validatePayload(pendingAction.tool, mergedPayload);
    } catch (err: any) {
      return NextResponse.json(
        { error: `Invalid edits: ${err.message}` },
        { status: 400 }
      );
    }
  }

  // 6. Process the decision
  let result;
  try {
    result = processDecision(body, pendingAction as any);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message },
      { status: 400 },
    );
  }

  // 7. Audit log the decision (using internal UUID)
  await logHitlDecision({
    orgId: access.internal_org_id!,
    threadId,
    userId: access.internal_user_id,
    actionType: pendingAction.tool,
    decision: body.action,
    originalPayload: pendingAction.payload,
    editedPayload: body.action === "edit" ? (result.payload as Record<string, unknown>) : null,
  });

  // 8. Update state
  const stateUpdate = result.approved
    ? {
        pending_write_action: {
          tool: pendingAction.tool,
          payload: result.payload,
          requested_at: pendingAction.requested_at,
        },
        // Clear awaiting_approval so the supervisor's pre-LLM guard can
        // distinguish "just approved, ready to execute" from "still waiting".
        // Without this flag, the resumed supervisor can't route to
        // action_executor — it would call the LLM again and mis-route.
        awaiting_approval: false,
      }
    : {
        pending_write_action: null,
        next_node: "END",
        run_status: "done",
      };

  await graph.updateState(
    { configurable: { thread_id: threadId } },
    stateUpdate,
  );

  // 9. Resume the graph and catch immediate failures (Fix M1)
  try {
    const stream = await graph.stream(null, { configurable: { thread_id: threadId } });
    
    // Drive the first step synchronously to verify the graph starts without error
    const iterator = stream[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    
    if (firstChunk.done) {
      logger.info({ threadId }, "[hitl] Graph resume finished immediately");
    } else {
      // Continue the rest of the execution in the background
      (async () => {
        try {
          for await (const _ of { [Symbol.asyncIterator]: () => iterator }) {
            // drives remaining execution
          }
        } catch (err) {
          logger.error({ threadId, err }, "[hitl] Background graph execution failed");
        }
      })();
    }
  } catch (err) {
    logger.error({
      threadId,
      error: err instanceof Error ? err.message : String(err),
    }, "[hitl] Graph resume failed immediately");
    
    return NextResponse.json(
      { error: "Action approved, but the system failed to execute it. Please contact support." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    decision: body.action,
    approved: result.approved,
  });
}
