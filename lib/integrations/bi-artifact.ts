// ============================================================
// lib/integrations/bi-artifact.ts — P4-5
//
// Helper for the bi_artifact shape: wrap embedded query-language bodies (DAX,
// LookML, SQL) in a fenced code block. Two payoffs downstream:
//   · the P1 chunk-policy engine sees a high codeFenceRatio → fence-atomic
//     chunking, so a measure/query body is never split mid-statement;
//   · the P3-4 (D8) fence-aware normalizeContent copies the fenced body
//     byte-identical, so operators/indentation survive into the embedding.
// ============================================================

/**
 * Wrap a code body in a labeled markdown fence. Returns '' for empty input so
 * callers can drop the line. The body is emitted verbatim (no trimming beyond
 * outer whitespace) so fence-aware normalization preserves it byte-identical.
 */
export function fenceCode(lang: string, body: string | null | undefined): string {
  const code = (body ?? '').trim()
  if (!code) return ''
  return '```' + lang + '\n' + code + '\n```'
}
