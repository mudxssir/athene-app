import { resolveModelClient } from "@/lib/langgraph/llm-factory";
import type { DiffResult, AlertSeverity } from "./types";

const CRITICAL_SIGNALS = [
  "critical", "breach", "outage", "down", "failed", "error", "urgent",
  "blocked", "overdue", "exceeded", "dropped", "declined", "lost",
];
const WARNING_SIGNALS = [
  "warning", "degraded", "slow", "delayed", "pending", "risk",
  "behind", "missed", "below target",
];

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

function classifySeverity(answer: string): AlertSeverity {
  const lower = answer.toLowerCase();
  if (CRITICAL_SIGNALS.some((s) => lower.includes(s))) return "critical";
  if (WARNING_SIGNALS.some((s) => lower.includes(s))) return "warning";
  return "info";
}

async function llmJudge(
  previous: string,
  current: string,
  orgId: string,
): Promise<{ changed: boolean; summary: string }> {
  const llm = await resolveModelClient("fast", orgId);
  const prompt = `You are comparing two answers to the same standing query in an enterprise intelligence system.

Previous answer:
${previous.slice(0, 800)}

Current answer:
${current.slice(0, 800)}

Respond with JSON only, no markdown fences:
{
  "changed": true|false,
  "summary": "one sentence describing what changed, or 'No material change' if unchanged"
}

A change is material if the factual content, key numbers, or status indicators differ — not if the phrasing changed.`;

  try {
    const result = await llm.invoke(prompt);
    const text = typeof result.content === "string"
      ? result.content
      : (result.content as any[]).map((c: any) => c.text ?? "").join("");
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    // Fallback: treat as changed to err on side of alerting
    return { changed: true, summary: "Answer content has changed." };
  }
}

export async function diffAnswers(
  previousAnswer: string | null,
  previousHash: string | null,
  currentAnswer: string,
  currentHash: string,
  orgId: string,
): Promise<DiffResult> {
  // First run — no previous answer to compare
  if (!previousAnswer || !previousHash) {
    return {
      changed: false,
      severity: "info",
      summary: "Initial answer recorded.",
    };
  }

  // Fast path: identical hash
  if (previousHash === currentHash) {
    return { changed: false, severity: "info", summary: "No change." };
  }

  const prevTokens = tokenize(previousAnswer);
  const currTokens = tokenize(currentAnswer);
  const similarity = jaccardSimilarity(prevTokens, currTokens);

  // Clearly different — skip LLM
  if (similarity < 0.55) {
    const severity = classifySeverity(currentAnswer);
    const summary = `Answer changed significantly (${Math.round((1 - similarity) * 100)}% different).`;
    return { changed: true, severity, summary };
  }

  // High overlap — rewording, not a material change
  if (similarity > 0.85) {
    return { changed: false, severity: "info", summary: "No material change." };
  }

  // Borderline (0.55–0.85) — LLM judge to avoid false positives on rewording
  const judgment = await llmJudge(previousAnswer, currentAnswer, orgId);
  if (!judgment.changed) {
    return { changed: false, severity: "info", summary: "No material change." };
  }

  return {
    changed: true,
    severity: classifySeverity(currentAnswer),
    summary: judgment.summary,
  };
}
