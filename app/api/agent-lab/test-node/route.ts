import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { supervisor } from "@/lib/langgraph/nodes/supervisor";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/redis/client";
import { retrievalAgent } from "@/lib/langgraph/nodes/retrieval-agent";
import { emailAgentNode } from "@/lib/langgraph/nodes/email-agent";
import { calendarAgentNode } from "@/lib/langgraph/nodes/calendar-agent";
import { synthesisAgentNode } from "@/lib/langgraph/nodes/synthesis-agent";
import { actionExecutorNode } from "@/lib/langgraph/nodes/action-executor";
import { parseBody } from "@/lib/validation";

const VALID_NODE_NAMES = ["supervisor", "retrieval", "email_agent", "calendar_agent", "synthesis", "action_executor"] as const;

const TestNodeSchema = z.object({
  nodeName:  z.enum(VALID_NODE_NAMES),
  mockState: z.record(z.string(), z.unknown()).optional().default({}),
});

const NODE_MAP: Record<string, any> = {
  supervisor,
  retrieval: retrievalAgent,
  email_agent: emailAgentNode,
  calendar_agent: calendarAgentNode,
  synthesis: synthesisAgentNode,
  action_executor: actionExecutorNode,
};

export async function POST(req: NextRequest) {
  try {
    const { userId, orgId } = await auth();
    if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });

    // Rate limit: 30 node test executions per user per hour (each invokes a live LLM node)
    const { allowed } = await rateLimit(`agent-lab:test-node:${userId}`, 30, 3600);
    if (!allowed) return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });

    let raw: unknown;
    try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsed = parseBody(TestNodeSchema, raw);
    if (!parsed.success) return parsed.response;
    const { nodeName, mockState } = parsed.data;

    const nodeFn = NODE_MAP[nodeName];
    if (!nodeFn) {
      return NextResponse.json({ error: `Node ${nodeName} not found` }, { status: 404 });
    }

    // Execute node in isolation
    const result = await nodeFn({
      ...mockState,
      userId,
      orgId,
    });

    return NextResponse.json({
      node: nodeName,
      output: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    logger.error({ err: error?.message ?? String(error) }, "[test-node] Error");
    return NextResponse.json({ error: "Node execution failed" }, { status: 500 });
  }
}
