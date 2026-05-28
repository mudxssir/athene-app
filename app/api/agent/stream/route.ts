import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { HumanMessage } from "@langchain/core/messages";
import { getAgentGraph } from "@/lib/langgraph/graph";
import { mapRole } from "@/lib/auth/clerk";
import { rateLimit } from "@/lib/redis/client";
import { logger } from "@/lib/logger";
import { parseBody } from "@/lib/validation";

const AgentStreamSchema = z.object({
  query:    z.string().min(1).max(10000),
  threadId: z.string().max(255).optional(),
});

/**
 * POST /api/agent/stream
 *
 * Accepts: { query: string, threadId?: string }
 * Streams SSE events: token, tool_start, tool_end, interrupt, state, done, error
 *
 * Uses LangGraph streamEvents for token-level + tool event streaming.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId, orgId, orgRole } = await auth();
    if (!userId || !orgId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    let raw: unknown;
    try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsed = parseBody(AgentStreamSchema, raw);
    if (!parsed.success) return parsed.response;
    const { query, threadId } = parsed.data;

    const { allowed } = await rateLimit(`agent:${userId}`, 10, 60);
    if (!allowed) {
      return NextResponse.json({ error: "Rate limit reached. Try again in 60s." }, { status: 429, headers: { "Retry-After": "60" } });
    }

    const role = mapRole(orgRole ?? undefined) ?? "member";
    const graph = await getAgentGraph();
    const resolvedThreadId = threadId || `user-${userId}-${Date.now()}`;

    const encoder = new TextEncoder();
    const transform = new TransformStream();
    const writer = transform.writable.getWriter();

    (async () => {
      try {
        const eventStream = await graph.streamEvents(
          {
            messages: [new HumanMessage(query)],
            orgId,
            userId,
            role,
          },
          {
            configurable: { thread_id: resolvedThreadId },
            version: "v2",
          }
        );

        for await (const event of eventStream as AsyncIterable<any>) {
          switch (event.event) {
            case "on_llm_new_token":
              if (event.data?.token) {
                await writer.write(
                  encoder.encode(
                    `event: token\ndata: ${JSON.stringify({ token: event.data.token })}\n\n`
                  )
                );
              }
              break;

            case "on_chat_model_stream": {
              // Suppress tokens from internal agent nodes that produce structured
              // JSON (email drafts, action payloads) — those are surfaced via the
              // interrupt event, not the chat stream.
              const node = event.metadata?.langgraph_node as string | undefined;
              const internalNodes = new Set(["email_agent", "calendar_agent", "action_executor"]);
              if (!node || !internalNodes.has(node)) {
                if (event.data?.chunk?.content) {
                  const content = event.data.chunk.content;
                  const token = typeof content === "string" ? content : "";
                  if (token) {
                    await writer.write(
                      encoder.encode(
                        `event: token\ndata: ${JSON.stringify({ token })}\n\n`
                      )
                    );
                  }
                }
              }
              break;
            }

            case "on_tool_start":
              await writer.write(
                encoder.encode(
                  `event: tool_start\ndata: ${JSON.stringify({
                    tool: event.name,
                    input: event.data?.input ?? {},
                  })}\n\n`
                )
              );
              break;

            case "on_tool_end":
              await writer.write(
                encoder.encode(
                  `event: tool_end\ndata: ${JSON.stringify({
                    tool: event.name,
                    output: event.data?.output ?? null,
                  })}\n\n`
                )
              );
              break;
          }
        }

        // Inspect final state for interrupts / completion
        const finalState = await graph.getState({
          configurable: { thread_id: resolvedThreadId },
        });

        const vals = finalState?.values as Record<string, unknown> | undefined;

        if (vals?.awaiting_approval) {
          const pending = vals.pending_write_action as {
            tool: string;
            payload: Record<string, unknown>;
            requested_at: string;
          } | null;

          if (pending) {
            await writer.write(
              encoder.encode(
                `event: interrupt\ndata: ${JSON.stringify(pending)}\n\n`
              )
            );
          }
        } else if (vals) {
          await writer.write(
            encoder.encode(
              `event: state\ndata: ${JSON.stringify({
                status: vals.run_status || "completed",
                final_answer: vals.final_answer ?? null,
                cited_sources: (vals.cited_sources as unknown[]) || [],
                awaiting_approval: false,
                threadId: resolvedThreadId,
              })}\n\n`
            )
          );
        }

        await writer.write(
          encoder.encode(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        );
        await writer.close();
      } catch (err: unknown) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, "[agent/stream] Stream error");
        const message = err instanceof Error ? err.message : "Internal Server Error";
        try {
          await writer.write(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message })}\n\n`
            )
          );
          await writer.close();
        } catch {
          // writer may already be closed
        }
      }
    })();

    return new Response(transform.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Thread-Id": resolvedThreadId,
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    logger.error({ err: msg }, "[agent/stream] API error");
    return new NextResponse(msg, { status: 500 });
  }
}
