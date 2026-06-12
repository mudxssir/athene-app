// ============================================================
// lib/knowledge-graph/extraction-gate.ts — Tier A/B gate (REFOCUS §5.3)
//
// Cost control for LLM extraction:
//   Tier A — full KG + event extraction: issue trackers, PRs,
//            docs, email. Always extracted.
//   Tier B — embeddings only by default: Slack (high volume,
//            low signal density). A Tier B document is promoted
//            to Tier A only when its text matches a decision/
//            blocker signal pattern — a cheap regex gate that
//            runs before any LLM call.
//
// P1-4: shape-aware tier function (gated on PIPELINE_SHAPE_ROUTING).
//   Tier A — prose, email, work_item: always full LLM
//   Tier B — thread: signal-pattern gated; record: description > 200 chars
//   Tier C — tabular, bi_artifact, media, code: deterministic only, no LLM
// ============================================================

import type { DataShape } from '@/lib/integrations/base'

/** Source types that always get full LLM extraction. */
const TIER_A_SOURCE_TYPES = new Set([
  "jira",
  "linear",
  "github",
  "pagerduty",
  "confluence",
  "notion",
  "google_drive",
  "sharepoint",
  "gmail",
  "outlook",
  "email",
  "file_upload",
]);

/** Embeddings-only by default; promoted on signal match. */
const TIER_B_SOURCE_TYPES = new Set(["slack"]);

/**
 * Decision / blocker signal patterns. Deliberately high-recall:
 * a false positive costs one LLM call, a false negative loses a
 * decision or blocker from the graph.
 */
const SIGNAL_PATTERNS: RegExp[] = [
  // decisions
  /\bdecid(?:e|ed|ing|sion)\b/i,
  /\b(?:agreed|approved|signed?[- ]off|green[- ]?lit)\b/i,
  /\b(?:chose|chosen|going with|went with|opted for|settled on)\b/i,
  /\b(?:postpon|cancel+ed|descoped|deprioritiz)/i,
  // blockers
  /\bblock(?:ed|s|ing|er)\b/i,
  /\bwaiting (?:on|for)\b/i,
  /\bdepends? on\b/i,
  /\bcan'?t (?:start|merge|ship|proceed|deploy) (?:until|without)\b/i,
  /\bpending (?:review|approval|sign[- ]?off)\b/i,
  /\bstuck (?:on|behind|until)\b/i,
  // obligations / escalations
  /\bdeadline\b/i,
  /\bcommit(?:ted)? to\b/i,
  /\bescalat/i,
  /\b(?:owe|owes|promised)\b/i,
];

/**
 * Decide whether a document should get LLM extraction.
 *
 * - Tier A source → always true.
 * - Tier B source → true only if any chunk matches a signal pattern.
 * - Unknown source → treated as Tier A (existing behavior; new
 *   high-volume sources must be added to TIER_B_SOURCE_TYPES
 *   explicitly per the "no new LLM calls without a gate" rule).
 */
export function shouldRunExtraction(
  sourceType: string | null | undefined,
  chunkTexts: string[]
): boolean {
  const src = (sourceType ?? "").toLowerCase();
  if (!src || TIER_A_SOURCE_TYPES.has(src)) return true;
  if (!TIER_B_SOURCE_TYPES.has(src)) return true;

  return chunkTexts.some((text) =>
    SIGNAL_PATTERNS.some((pattern) => pattern.test(text))
  );
}

/**
 * Shape-aware extraction tier (P1-4, requires PIPELINE_SHAPE_ROUTING flag).
 *
 * Tier A — full LLM extraction always run.
 * Tier B — LLM extraction gated by a cheap heuristic.
 * Tier C — deterministic only; LLM extraction never run.
 */
export function extractionTier(
  shape: DataShape,
  chunkTexts: string[]
): 'A' | 'B' | 'C' {
  switch (shape) {
    case 'prose':
    case 'email':
    case 'work_item':
      return 'A'

    case 'thread':
      // Signal-pattern gate (same logic as legacy Slack gating)
      return chunkTexts.some((t) => SIGNAL_PATTERNS.some((p) => p.test(t))) ? 'A' : 'B'

    case 'record':
      // PLAN_A: promote only records with a meaningful description (>200 chars).
      // A record chunk is the WHOLE formatted record ("Field: value" lines), so
      // checking total chunk length promoted virtually every CRM/calendar record
      // to Tier A — recreating the LLM cost this gate exists to prevent. Free-text
      // descriptions surface as long single lines; field lines stay short. Gate on
      // the longest line instead.
      return chunkTexts.some((t) => t.split('\n').some((line) => line.length > 200)) ? 'A' : 'B'

    case 'tabular':
    case 'bi_artifact':
    case 'media':
    case 'code':
      return 'C'
  }
}
