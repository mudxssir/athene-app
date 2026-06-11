// lib/indexing/chunk-policy.ts — P1-5 + P1-6
// Dynamic per-document chunk policy engine (PLAN_A §0.4).
// Pure functions — no I/O, no side effects, unit-tested.

import { encode } from 'gpt-tokenizer'
import type { DataShape } from '@/lib/integrations/base'

export interface ChunkSignals {
  tokens: number
  headingDensity: number  // headings per 1k tokens
  tableDensity: number    // pipe-table / CSV-line ratio
  codeFenceRatio: number  // fenced-block lines / total lines
  sentenceLen: number     // mean sentence length in chars
  listRatio: number       // list-item lines / total lines
}

export type ChunkStrategy =
  | 'passthrough'  // whole doc is one chunk (below noSplitCeiling)
  | 'structural'   // markdown heading-tree splitting
  | 'fence-atomic' // token chunker + code fences are unsplittable units
  | 'token'        // fixed-window token chunker

export interface ChunkPlan {
  strategy: ChunkStrategy
  childTarget: number        // target tokens per embedded child chunk
  parentTarget: number | null // target tokens per retrieval parent (null = whole doc)
  overlap: number            // fraction of childTarget to overlap (0–1)
  noSplitCeiling: number     // doc is a single chunk below this token count
}

/** Hard cap: docs larger than this are truncated before chunking. */
export const TRUNCATE_TOKEN_CAP = 200_000
/** Minimum tokens a structural chunk must contain after merge. */
export const MIN_TOKENS = 64
/** Hard maximum child chunks per document. */
export const MAX_CHUNKS_PER_DOC = 400

// PLAN_A §0.4 base plans. selectStrategy may override strategy based on signals.
const BASE_PLANS: Record<DataShape, ChunkPlan> = {
  prose:      { strategy: 'structural',  childTarget: 320, parentTarget: 1200, overlap: 0,    noSplitCeiling: 600 },
  email:      { strategy: 'token',       childTarget: 512, parentTarget: null, overlap: 0.10, noSplitCeiling: 800 },
  thread:     { strategy: 'token',       childTarget: 512, parentTarget: null, overlap: 0.15, noSplitCeiling: 600 },
  work_item:  { strategy: 'token',       childTarget: 512, parentTarget: null, overlap: 0.10, noSplitCeiling: 800 },
  record:     { strategy: 'token',       childTarget: 512, parentTarget: null, overlap: 0,    noSplitCeiling: 750 },
  tabular:    { strategy: 'token',       childTarget: 768, parentTarget: null, overlap: 0,    noSplitCeiling: 1200 },
  bi_artifact:{ strategy: 'token',       childTarget: 512, parentTarget: null, overlap: 0,    noSplitCeiling: 800 },
  media:      { strategy: 'passthrough', childTarget: 512, parentTarget: null, overlap: 0,    noSplitCeiling: 99_999 },
  code:       { strategy: 'fence-atomic',childTarget: 512, parentTarget: null, overlap: 0.05, noSplitCeiling: 600 },
}

/**
 * Computes lightweight structural signals from document text.
 * Pure function — the only cost is the tokenizer call.
 */
export function computeSignals(text: string): ChunkSignals {
  if (!text?.trim()) {
    return { tokens: 0, headingDensity: 0, tableDensity: 0, codeFenceRatio: 0, sentenceLen: 0, listRatio: 0 }
  }

  // Avoid encoding enormous strings byte-by-byte; estimate stops at ~1M chars.
  const capChars = TRUNCATE_TOKEN_CAP * 5
  const safeText = text.length > capChars ? text.slice(0, capChars) : text
  const tokens = encode(safeText).length

  const lines = safeText.split('\n')
  const total = Math.max(lines.length, 1)

  const headingCount = lines.filter(l => /^#{1,4}\s/.test(l)).length
  const headingDensity = tokens > 0 ? headingCount / (tokens / 1000) : 0

  const tableLineCount = lines.filter(l => (l.match(/\|/g) ?? []).length >= 2 || l.split(',').length >= 3).length
  const tableDensity = tableLineCount / total

  let inFence = false
  let fenceLineCount = 0
  for (const l of lines) {
    if (/^```/.test(l.trim())) { inFence = !inFence; continue }
    if (inFence) fenceLineCount++
  }
  const codeFenceRatio = fenceLineCount / total

  const sentences = safeText.split(/[.?!]+[\s\n]/).filter(s => s.trim().length > 10)
  const sentenceLen = sentences.length > 0
    ? sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length
    : safeText.length

  const listLineCount = lines.filter(l => /^\s*(?:[-*]|\d+\.)\s/.test(l)).length
  const listRatio = listLineCount / total

  return { tokens, headingDensity, tableDensity, codeFenceRatio, sentenceLen, listRatio }
}

/**
 * Selects a ChunkPlan for a document from its shape and computed signals.
 *
 * Base plan comes from PLAN_A §0.4. Signals override strategy:
 * - Any shape below noSplitCeiling → passthrough (no splitting).
 * - Prose with headingDensity ≥ 1 → structural heading-tree splitting.
 * - Prose or code with codeFenceRatio > 0.3 → fence-atomic chunking.
 * - All other cases → fixed-window token chunker with plan's budget.
 */
export function selectStrategy(shape: DataShape, signals: ChunkSignals): ChunkPlan {
  const base = BASE_PLANS[shape] ?? BASE_PLANS['prose']

  if (signals.tokens <= base.noSplitCeiling) {
    return { ...base, strategy: 'passthrough' }
  }

  if (shape === 'prose') {
    if (signals.codeFenceRatio > 0.3) {
      return { ...base, strategy: 'fence-atomic', childTarget: 512, overlap: 0.05 }
    }
    if (signals.headingDensity >= 1.0) {
      return { ...base, strategy: 'structural' }
    }
    // Heading-poor prose: token chunking with mild overlap
    return { ...base, strategy: 'token', childTarget: 512, overlap: 0.10 }
  }

  if (shape === 'code') {
    return { ...base, strategy: 'fence-atomic' }
  }

  return base
}
