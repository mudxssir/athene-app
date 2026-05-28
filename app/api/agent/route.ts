export const maxDuration = 60; // LangGraph agent has 55s internal timeout; keep 5s headroom

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { cachedAuth } from "@/lib/auth/cached-clerk";
import { HumanMessage, isAIMessageChunk } from "@langchain/core/messages";
import { getAgentGraph } from "@/lib/langgraph/graph";
import { mapRole } from "@/lib/auth/clerk";
import { rateLimit, cached, redis } from "@/lib/redis/client";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { syncUserContext } from "@/lib/auth/sync";
import { withSSEFrameSpan, withAgentRunSpan } from "@/lib/telemetry/spans";
import { parseBody } from "@/lib/validation";

const AgentPostSchema = z.object({
  message:             z.string().min(1).max(10000),
  threadId:            z.string().min(1).max(255),
  task_type:           z.string().max(100).optional(),
  is_cross_dept_query: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const authResult = await cachedAuth(req);
    const { userId, orgId, orgRole } = authResult;

    if (!userId || !orgId) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    let raw: unknown;
    try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const parsedReq = parseBody(AgentPostSchema, raw);
    if (!parsedReq.success) return parsedReq.response;
    const { message, threadId, task_type, is_cross_dept_query } = parsedReq.data;

    const { allowed } = await rateLimit(`agent:${userId}`, 10, 60);
    if (!allowed) {
      return NextResponse.json({ error: "Rate limited" }, { status: 429 });
    }

    const effectiveThreadId = threadId;

    // Resolve internal org and user for thread persistence (cached)
    let orgRow = await cached(
      `org:clerk:${orgId}`,
      300,
      async () => {
        const { data } = await supabaseAdmin
          .from("organizations")
          .select("id")
          .eq("clerk_org_id", orgId)
          .single();
        return data;
      }
    );

    // ATH-PROD: Auto-sync organization if missing (Issue #404 fix)
    if (!orgRow) {
      const { data: newOrg, error: orgCreateError } = await supabaseAdmin
        .from("organizations")
        .insert({ 
          clerk_org_id: orgId,
          name: "Organization " + orgId.slice(-4), // Fallback name
          slug: "org-" + orgId.slice(-8)
        })
        .select("id")
        .limit(1)
        .maybeSingle();
      
      if (orgCreateError) {
        logger.error({ orgId, err: orgCreateError.message }, "[agent] Org sync failed");
        return NextResponse.json({ error: "Failed to sync organization" }, { status: 500 });
      }
      orgRow = newOrg;
    }

    // Org-level rate limit: 100 requests/min across all users in the org
    const { allowed: orgAllowed } = await rateLimit(`agent:org:${orgRow!.id}`, 100, 60);
    if (!orgAllowed) {
      return NextResponse.json({ error: "Org rate limit exceeded — try again shortly" }, { status: 429 });
    }

    let memberRow = await cached(
      `member:clerk:${userId}:${orgRow!.id}`,
      300,
      async () => {
        const { data } = await supabaseAdmin
          .from("org_members")
          .select("id, timezone, department_id")
          .eq("clerk_user_id", userId)
          .eq("org_id", orgRow!.id)
          .single();
        return data;
      }
    );

    // ATH-PROD: Auto-sync user membership if missing — fetch real email from Clerk
    if (!memberRow) {
      const syncResult = await syncUserContext(userId, orgId, orgRole ?? undefined);
      if (!syncResult.success) {
        logger.error({ userId, orgId, err: syncResult.error }, "[agent] Member sync failed");
        return NextResponse.json({ error: "Failed to sync user membership" }, { status: 500 });
      }
      const { data: syncedMember } = await supabaseAdmin
        .from("org_members")
        .select("id, timezone, department_id")
        .eq("clerk_user_id", userId)
        .eq("org_id", orgRow!.id)
        .maybeSingle();
      if (!syncedMember) {
        logger.error({ userId, orgId }, "[agent] Member not found after sync");
        return NextResponse.json({ error: "Failed to resolve user after sync" }, { status: 500 });
      }
      memberRow = syncedMember;
    }

    // 3. Ensure Thread Persistence (Required for HITL foreign keys)
    // orgRow and memberRow are guaranteed non-null by the sync blocks above.
    if (!orgRow || !memberRow) {
      return NextResponse.json({ error: "Failed to resolve organization or user." }, { status: 500 });
    }

    const { data: existingThread } = await supabaseAdmin
      .from("threads")
      .select("message_count")
      .eq("id", effectiveThreadId)
      .maybeSingle();

    const newMessageCount = (existingThread?.message_count || 0) + 1;

    const { error: threadError } = await supabaseAdmin
      .from("threads")
      .upsert({
        id: effectiveThreadId,
        org_id: orgRow.id,
        user_id: memberRow.id,
        message_count: newMessageCount,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });

    if (threadError) {
      logger.warn({ threadId: effectiveThreadId, err: threadError.message }, "[agent] Thread persistence failed - continuing with in-memory state only");
      // ATH-PROD: Do not return 500. Let the graph proceed even if DB sync fails
      // This prevents "Legacy Ghost" FK issues from blocking the entire chat.
    }

    const graph = await getAgentGraph();

    // 2D: Redis lock — prevent two concurrent requests from both passing the
    // awaiting_approval check and spawning parallel graph execution branches.
    const lockKey = `thread_lock:${effectiveThreadId}`;
    let lockAcquired = false;
    try {
      const lockResult = await redis.set(lockKey, "1", { nx: true, ex: 8 });
      lockAcquired = lockResult !== null;
    } catch {
      // Redis down — fail-open (still process, just without the lock guarantee)
      lockAcquired = true;
    }
    if (!lockAcquired) {
      return NextResponse.json(
        { error: "Previous message is still processing. Please wait a moment before sending another." },
        { status: 429 }
      );
    }

    let currentState: Awaited<ReturnType<typeof graph.getState>> | undefined;
    try {
      currentState = await graph.getState({ configurable: { thread_id: effectiveThreadId } });
    } catch {
      // Checkpoint not found — first message on this thread, fine to proceed
    }

    // ATH-43 + 2C: Block concurrent messages if the thread is awaiting approval.
    // Auto-expire approvals that have been pending for more than 24 hours so threads
    // don't get permanently locked when a user closes their browser.
    if (currentState?.values?.awaiting_approval) {
      const pendingAction = currentState.values.pending_write_action as
        | { requested_at?: string } | null | undefined;
      const requestedAt = pendingAction?.requested_at
        ? new Date(pendingAction.requested_at)
        : null;
      const isExpired = requestedAt
        ? Date.now() - requestedAt.getTime() > 24 * 60 * 60 * 1000
        : false;

      if (isExpired) {
        // Auto-reject the stale action and clear the lock state so the thread recovers
        logger.warn({ threadId: effectiveThreadId }, "[agent] HITL approval expired after 24h — auto-rejecting stale action");
        try {
          await graph.updateState(
            { configurable: { thread_id: effectiveThreadId } },
            { awaiting_approval: false, pending_write_action: null }
          );
        } catch (stateErr) {
          logger.error({ threadId: effectiveThreadId, err: stateErr }, "[agent] Failed to clear expired HITL state");
        }
      } else {
        try { await redis.del(lockKey); } catch { /* best-effort */ }
        return NextResponse.json(
          { error: "A specific action is awaiting your approval. Please approve, edit, or reject it before sending more messages." },
          { status: 409 }
        );
      }
    }

    const role = mapRole(orgRole ?? undefined) ?? "member";

    const initialState = {
      messages: [new HumanMessage(message)],
      orgId: orgRow.id,
      userId: memberRow.id,
      role,
      deptId: (memberRow as any)?.department_id ?? null,
      user: {
        id: userId,
        internalId: memberRow.id,
        timezone: (memberRow as any)?.timezone ?? "UTC",
      },
      task_type: task_type || "general",
      is_cross_dept_query: !!is_cross_dept_query,
    };

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    let firstTokenSent = false;
    const firstTokenTime = Date.now();
    // Track how many tokens have been streamed to the client.
    // When tokenCount > 0, the client is already accumulating content via token frames.
    // Sending `content` in a values frame at that point would overwrite the accumulated
    // text with whatever partial/intermediate state LangGraph happens to hold at that
    // node boundary — causing long responses to appear, shrink, or disappear entirely.
    let tokenCount = 0;

    (async () => {
      // Release the thread lock once the stream is initialised — the race-condition
      // window is closed once graph.stream() has started and taken ownership of state.
      try { await redis.del(lockKey); } catch { /* best-effort */ }

      try {
        await withAgentRunSpan(orgRow!.id, effectiveThreadId, async () => {
        const eventStream = await graph.stream(initialState, {
          configurable: {
            thread_id: effectiveThreadId,
          },
          streamMode: ["values", "messages"],
        });

        for await (const [mode, chunk] of eventStream as AsyncIterable<[string, any]>) {
          if (mode === "messages") {
            const messageChunk = (chunk as any[])?.[0];
            // Only stream tokens from AI model chunks — skip HumanMessage and
            // ToolMessage objects that LangGraph also emits in "messages" mode.
            // Without this guard, the user's own question and tool-result strings
            // (e.g. "[Retrieval complete] Found N chunks") appear in the assistant bubble.
            if (!isAIMessageChunk(messageChunk)) continue;
            if (messageChunk?.content) {
              const token = typeof messageChunk.content === "string"
                ? messageChunk.content
                : Array.isArray(messageChunk.content)
                  ? messageChunk.content.map((c: any) => c.text || "").join("")
                  : "";
              if (token && !firstTokenSent) {
                firstTokenSent = true;
                logger.info({ latencyMs: Date.now() - firstTokenTime }, "[agent] First token latency");
              }
              if (token) {
                tokenCount++;
                const data = JSON.stringify({ token });
                await withSSEFrameSpan("llm_token", async () => {
                  await writer.write(encoder.encode(`data: ${data}\n\n`));
                });
              }
            }
          } else if (mode === "values") {
            const messages = chunk.messages as any[] | undefined;
            const lastMessage = messages?.[messages.length - 1];

            // Always emit metadata (cited_sources, awaiting_approval, active_agent).
            // Only include `content` when NO tokens have been streamed yet — i.e. this
            // is a non-streaming response path (tool-only reply, routing message, etc.).
            // Once tokens are streaming the client accumulates text via token frames;
            // injecting `content` from an intermediate graph-node state would overwrite
            // the accumulated text with whatever the last LangGraph message happens to
            // be at that boundary (often a ToolMessage or partial AIMessage).
            const frame: Record<string, unknown> = {
              cited_sources: chunk.cited_sources ?? [],
              awaiting_approval: chunk.awaiting_approval ?? false,
              pending_write_action: chunk.pending_write_action ?? null,
              active_agent: chunk.next ?? null,
            };

            if (tokenCount === 0 && lastMessage) {
              // Non-streaming path: surface the full message content to the client.
              // Only include if the last message carries actual text (not a tool call).
              const contentStr = typeof lastMessage.content === "string"
                ? lastMessage.content
                : "";
              if (contentStr) frame.content = contentStr;
            }

            await withSSEFrameSpan("agent_chunk", async () => {
              await writer.write(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            });
          }
        }
        await writer.close();
        }); // withAgentRunSpan
      } catch (err: any) {
        logger.error({ err: err?.message }, "[agent] Stream error");
        const isQuota = err.message.includes("quota") || err.message.includes("rate_limit") || err.message.includes("429");
        const errorData = JSON.stringify({
          error: true,
          content: isQuota
            ? "Synthesis halted: LLM quota exceeded. Check your API key billing or add a BYOK key in Admin → Keys."
            : `Synthesis error: ${err.message}`,
        });
        await writer.write(encoder.encode(`data: ${errorData}\n\n`));
        await writer.close();
      }
    })();

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    logger.error({ err: msg }, "[agent] API error");
    return new NextResponse(msg, { status: 500 });
  }
}
