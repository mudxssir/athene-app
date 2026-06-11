// lib/integrations/sidecar-shadow.ts — P1-12
// Shadow-mode comparison: parse N% of documents via the sidecar alongside
// the inline TS parser, log structural-diff metrics, emit no user-facing output.
//
// Shadow mode is purely observational. It never affects the indexed content —
// only the sidecar's output is compared; the inline parser's output is always
// what gets indexed.
//
// Activation: set SIDECAR_SHADOW_RATE=0.05 (5%) to sample 1-in-20 documents.
// Default is 0 (disabled). Values >1 are treated as 1 (100%).
//
// Metrics logged per sampled document:
//   - inline_chars, sidecar_chars: character lengths of each output
//   - heading_delta:  Δ markdown headings (sidecar − inline)
//   - table_delta:    Δ pipe-table lines  (sidecar − inline)
//   - fence_delta:    Δ code fence opens  (sidecar − inline)
//   - parser_used:    which sidecar parser won (docling|markitdown|plain)
//   - duration_ms:    sidecar round-trip time

import 'server-only'
import { logger } from '@/lib/logger'
import { parseSidecar, sidecarAvailable } from './sidecar-client'

const SHADOW_RATE = Math.min(1, Math.max(0, parseFloat(process.env.SIDECAR_SHADOW_RATE ?? '0')))

// Simple counter per process so we don't have to hash every doc to decide.
let _counter = 0

/**
 * If shadow mode is active and this document is selected by the sample rate,
 * sends the raw content to the sidecar, then logs the structural diff.
 * Always resolves (never throws) — shadow mode must never block indexing.
 *
 * @param inlineMarkdown  - the text that will actually be indexed (inline parser output)
 * @param rawBuffer       - original binary content to send to the sidecar
 * @param filename        - filename with extension (helps sidecar pick parser)
 * @param orgId           - org routing header (opaque to sidecar)
 */
export async function maybeShadowParse(
  inlineMarkdown: string,
  rawBuffer: Buffer,
  filename: string,
  orgId?: string,
): Promise<void> {
  if (SHADOW_RATE <= 0) return
  if (!sidecarAvailable()) return

  _counter++
  const shouldSample = (_counter % Math.round(1 / SHADOW_RATE)) === 0
  if (!shouldSample) return

  try {
    const result = await parseSidecar(rawBuffer, filename, orgId)
    if (!result) return

    const diff = computeStructuralDiff(inlineMarkdown, result.markdown)

    logger.info(
      {
        filename,
        parser_used: result.parser_used,
        parser_version: result.parser_version,
        inline_chars: inlineMarkdown.length,
        sidecar_chars: result.markdown.length,
        heading_delta: diff.headingDelta,
        table_delta: diff.tableDelta,
        fence_delta: diff.fenceDelta,
        sidecar_duration_ms: result.duration_ms,
      },
      '[sidecar-shadow] structural diff'
    )
  } catch (err) {
    // Shadow failures must never bubble up
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[sidecar-shadow] comparison failed (non-fatal)'
    )
  }
}

// ── Structural diff ───────────────────────────────────────────────────────────

interface StructuralDiff {
  headingDelta: number
  tableDelta: number
  fenceDelta: number
}

function computeStructuralDiff(inline: string, sidecar: string): StructuralDiff {
  return {
    headingDelta: countHeadings(sidecar) - countHeadings(inline),
    tableDelta:   countTableLines(sidecar) - countTableLines(inline),
    fenceDelta:   countFenceOpens(sidecar) - countFenceOpens(inline),
  }
}

function countHeadings(md: string): number {
  return (md.match(/^#{1,6}\s/gm) ?? []).length
}

function countTableLines(md: string): number {
  return (md.match(/^\s*\|/gm) ?? []).length
}

function countFenceOpens(md: string): number {
  return (md.match(/^```/gm) ?? []).length
}
