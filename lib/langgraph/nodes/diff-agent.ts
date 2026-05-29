/**
 * Diff Agent — answers "What changed since [date]?" queries.
 *
 * Runs two parallel retrievals across different time windows, then
 * synthesises a structured diff: what's new, what's gone, what shifted.
 *
 * Not wired into the graph yet. Add to graph.ts and supervisor routing
 * when ready to ship.
 */
import { AIMessage } from "@langchain/core/messages";
import type { AtheneState, AtheneStateUpdate } from "../state";
import { resolveModelClient } from "../llm-factory";
import { supabaseAdmin } from "@/lib/supabase/server";

const DIFF_SYSTEM_PROMPT = `You are an enterprise intelligence analyst comparing two snapshots of knowledge across a time window.

You have been given:
- PAST CONTEXT: what was true before the date boundary
- CURRENT CONTEXT: what is true now

Your task: write a structured diff in this exact format:

## What's New
- [bullet per new fact, entity, or status]

## What Changed
- [bullet per shifted metric, updated status, or altered relationship]

## What's Gone / Resolved
- [bullet per resolved issue, completed task, or removed entity]

## No Material Change
- [only if nothing changed in a category, write "None detected"]

Rules:
- Be specific: include names, numbers, dates.
- Skip categories that are empty (omit the header).
- If context is too sparse to compare, say so clearly.
- Do not hallucinate. Only state what the context supports.`;

interface TimeWindowChunks {
  past: string[];
  current: string[];
}

/** Fetch document chunks created within a time window */
async function fetchChunksInWindow(
  orgId: string,
  deptId: string | null,
  fromDate: Date,
  toDate: Date,
  limit = 30,
): Promise<string[]> {
  let query = supabaseAdmin
    .from("document_chunks")
    .select("content_preview, source_type, metadata")
    .eq("org_id", orgId)
    .gte("created_at", fromDate.toISOString())
    .lte("created_at", toDate.toISOString())
    .order("created_at", { ascending: false })
    .limit(limit);

  if (deptId) {
    query = query.eq("department_id", deptId);
  }

  const { data } = await query;
  return (data ?? []).map(
    (r: any) =>
      `[${r.source_type}] ${r.content_preview}${r.metadata?.chunk_text ? " " + r.metadata.chunk_text.slice(0, 300) : ""}`,
  );
}

/** Parse a natural language time reference into a Date boundary */
function parseTimeBoundary(query: string): Date {
  const lower = query.toLowerCase();
  const now = new Date();

  if (lower.includes("today")) return new Date(now.setHours(0, 0, 0, 0));
  if (lower.includes("yesterday")) {
    const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d;
  }
  if (lower.includes("this week") || lower.includes("last 7")) {
    const d = new Date(now); d.setDate(d.getDate() - 7); return d;
  }
  if (lower.includes("this month") || lower.includes("last 30")) {
    const d = new Date(now); d.setDate(d.getDate() - 30); return d;
  }
  if (lower.includes("last quarter") || lower.includes("q1") || lower.includes("q2") || lower.includes("q3") || lower.includes("q4")) {
    const d = new Date(now); d.setDate(d.getDate() - 90); return d;
  }
  // Default: last 14 days
  const d = new Date(now); d.setDate(d.getDate() - 14); return d;
}

export async function diffAgentNode(
  state: AtheneState,
): Promise<AtheneStateUpdate> {
  const { orgId, deptId, messages } = state;
  const userQuery = messages.filter((m) => m._getType() === "human").pop()?.content;
  if (!userQuery || typeof userQuery !== "string") {
    return {
      messages: [new AIMessage("I need a query to compare. Try: 'What changed in engineering this week?'")],
      run_status: "done",
    };
  }

  const boundary = parseTimeBoundary(userQuery);
  const now = new Date();
  // "Past" window: equal-length period before the boundary
  const windowMs = now.getTime() - boundary.getTime();
  const pastStart = new Date(boundary.getTime() - windowMs);

  const [pastChunks, currentChunks] = await Promise.all([
    fetchChunksInWindow(orgId, deptId, pastStart, boundary),
    fetchChunksInWindow(orgId, deptId, boundary, now),
  ]) as [TimeWindowChunks["past"], TimeWindowChunks["current"]];

  if (!pastChunks.length && !currentChunks.length) {
    return {
      messages: [new AIMessage("Not enough data in both time windows to compare. Connect more sources or choose a wider time range.")],
      run_status: "done",
    };
  }

  const prompt = `${DIFF_SYSTEM_PROMPT}

User query: "${userQuery}"
Comparing: before ${boundary.toDateString()} vs after ${boundary.toDateString()}

PAST CONTEXT (${pastChunks.length} items):
${pastChunks.slice(0, 20).join("\n---\n") || "(no data)"}

CURRENT CONTEXT (${currentChunks.length} items):
${currentChunks.slice(0, 20).join("\n---\n") || "(no data)"}`;

  const llm = await resolveModelClient("medium", orgId);
  const result = await llm.invoke(prompt);
  const answer = typeof result.content === "string"
    ? result.content
    : (result.content as any[]).map((c: any) => c.text ?? "").join("");

  return {
    messages: [new AIMessage(answer)],
    final_answer: answer,
    run_status: "done",
    task_type: "diff",
  };
}
