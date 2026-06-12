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

/** Marker appended when a document is cut at TRUNCATE_TOKEN_CAP. */
export const TRUNCATION_MARKER = '\n\n[truncated]'

// gpt-tokenizer's BPE is quadratic in unbroken-run length: 500k chars of one
// run takes ~3 minutes, while 500k chars of natural prose takes ~9 ms
// (measured). Runs this long only occur in garbage input (base64 blobs,
// minified bundles), so they are token-estimated instead of encoded. The
// 4-chars/token estimate errs HIGH for compressible runs — the safe
// direction: over-counting truncates earlier and splits more.
const MONSTER_RUN_CHARS = 2048
const MONSTER_RUN_TEST = /\S{2048}/
const MONSTER_RUN_SPLIT = /(\S{2048,})/

/**
 * Token count that is safe on adversarial input. Natural text goes through
 * the real tokenizer; unbroken runs ≥ 2048 chars are estimated. Never throws,
 * cost is linear in text length.
 *
 * Texts containing monster runs are processed in 64k-char slices so the
 * unbounded-repetition regex never runs on megabyte input (V8's backtracking
 * stack overflows there). Slice boundaries cost at most ±1 token each —
 * irrelevant for routing and cap decisions.
 */
export function countTokens(text: string): number {
  if (!text) return 0
  if (!MONSTER_RUN_TEST.test(text)) return encode(text).length

  const SLICE = 65_536
  let total = 0
  for (let i = 0; i < text.length; i += SLICE) {
    const slice = text.slice(i, i + SLICE)
    if (!MONSTER_RUN_TEST.test(slice)) {
      total += encode(slice).length
      continue
    }
    for (const part of slice.split(MONSTER_RUN_SPLIT)) {
      if (!part) continue
      if (part.length >= MONSTER_RUN_CHARS && !/\s/.test(part)) {
        total += Math.ceil(part.length / 4)
      } else {
        total += encode(part).length
      }
    }
  }
  return total
}

/**
 * Inserts a space every 2048 chars inside unbroken monster runs so the exact
 * tokenizer (chunker.ts encode/decode) never hits the quadratic BPE path.
 * Natural text is returned unchanged; only garbage runs are altered.
 */
export function neutralizeMonsterRuns(text: string): string {
  if (!MONSTER_RUN_TEST.test(text)) return text
  return text.replace(/\S{2048}/g, '$& ')
}

/**
 * Enforces the 200k-token document cap (playbook P1 item 7).
 *
 * Documents at or under cap-chars pass without tokenizing (practical text is
 * ≥1 char/token; byte-heavy outliers are bounded downstream by
 * MAX_CHUNKS_PER_DOC). Larger documents are counted with countTokens and cut
 * by accumulating fixed-size slices up to the cap. Pure function — never
 * throws, linear cost.
 */
export function truncateAtTokenCap(text: string): { text: string; truncated: boolean } {
  if (text.length <= TRUNCATE_TOKEN_CAP) {
    return { text, truncated: false }
  }
  if (countTokens(text) <= TRUNCATE_TOKEN_CAP) {
    return { text, truncated: false }
  }

  const SLICE_CHARS = 32_000
  let tokens = 0
  let cut = 0
  while (cut < text.length) {
    const slice = text.slice(cut, cut + SLICE_CHARS)
    const n = countTokens(slice)
    if (tokens + n > TRUNCATE_TOKEN_CAP) {
      const frac = (TRUNCATE_TOKEN_CAP - tokens) / n
      cut += Math.max(1, Math.floor(slice.length * frac))
      break
    }
    tokens += n
    cut += slice.length
  }
  return { text: text.slice(0, cut) + TRUNCATION_MARKER, truncated: true }
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
  // countTokens (not raw encode): unbroken monster runs would otherwise hit
  // the tokenizer's quadratic BPE path and hang the indexer.
  const capChars = TRUNCATE_TOKEN_CAP * 5
  const safeText = text.length > capChars ? text.slice(0, capChars) : text
  const tokens = countTokens(safeText)

  const lines = safeText.split('\n')
  const total = Math.max(lines.length, 1)

  const headingCount = lines.filter(l => /^#{1,4}\s/.test(l)).length
  const headingDensity = tokens > 0 ? headingCount / (tokens / 1000) : 0

  // Pipe-table rows only. Comma counting was removed: ordinary prose routinely
  // has 2+ commas per line, which made every paragraph look like a table row.
  // tableDensity / sentenceLen / listRatio are computed but not yet consumed by
  // selectStrategy — reserved for the P3/P4 table-aware overrides (PLAN_A §0.4).
  const tableLineCount = lines.filter(l => (l.match(/\|/g) ?? []).length >= 2).length
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
