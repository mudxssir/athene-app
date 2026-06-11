// P1-3 + P1-5/P1-6 unit tests: shape-based chunkContent + resolveEmbeddingHint
// Updated for chunk-policy engine: flag-ON now routes through computeSignals →
// selectStrategy → execute plan, replacing the old inline shape-switch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Feature flag mock ────────────────────────────────────────────────────────

let shapeFlagValue = false

vi.mock('@/lib/config/feature-flags', () => ({
  get PIPELINE_SHAPE_ROUTING() { return shapeFlagValue },
}))

// Mock the token-window chunker — returns a labeled string so tests can
// assert which chunkSize/overlap the policy engine selected.
vi.mock('@/lib/langgraph/tools/chunker', () => ({
  chunk: (text: string, opts: { chunkSize: number; overlap: number }) => {
    return [{ text: `[chunk:${opts.chunkSize}/${opts.overlap}] ${text.slice(0, 20)}` }]
  },
}))

// Mock structural-chunker so tests don't depend on gpt-tokenizer encoding
// for heading-split or fence-atomic paths. The real implementation is tested
// in lib/indexing/__tests__/structural-chunker.test.ts.
vi.mock('@/lib/indexing/structural-chunker', () => ({
  splitByHeadings: (text: string) => [{ text: `[structural] ${text.slice(0, 20)}`, headingTrail: [] }],
  splitFenceAtomic: (text: string, target: number, overlap: number) => [
    { text: `[fence:${target}/${overlap.toFixed(2)}] ${text.slice(0, 20)}`, headingTrail: [] },
  ],
  groupIntoParents: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { chunkContent, resolveEmbeddingHint } from '@/lib/integrations/indexing'

// ── Test content ─────────────────────────────────────────────────────────────
// SHORT: well below every noSplitCeiling → passthrough for all shapes
// LONG: reliably above every noSplitCeiling (prose=600, tabular=1200, etc.)
//   'word '.repeat(2000) ≈ 10000 chars; gpt-tokenizer encodes ~2000–4000 tokens

const SHORT = 'hi '.repeat(5)           // ~15 chars, ~5 tokens
const LONG  = 'word '.repeat(2000)      // ~10k chars, well over 1200 tok ceiling

// ── chunkContent: flag ON ────────────────────────────────────────────────────

describe('chunkContent — flag ON', () => {
  beforeEach(() => { shapeFlagValue = true })
  afterEach(() => { shapeFlagValue = false })

  // ---- Passthrough: short content stays as one chunk for all shapes --------

  it('record short → passthrough (single chunk)', () => {
    const result = chunkContent(SHORT, 'record')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })

  it('tabular short → passthrough (single chunk)', () => {
    const result = chunkContent(SHORT, 'tabular')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })

  it('bi_artifact short → passthrough (single chunk)', () => {
    const result = chunkContent(SHORT, 'bi_artifact')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })

  it('email short → passthrough (single chunk)', () => {
    const result = chunkContent(SHORT, 'email')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })

  it('thread short → passthrough (single chunk)', () => {
    const result = chunkContent(SHORT, 'thread')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })

  it('work_item short → passthrough (single chunk)', () => {
    const result = chunkContent(SHORT, 'work_item')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })

  it('media → always passthrough regardless of size', () => {
    expect(chunkContent(SHORT, 'media')).toEqual([SHORT])
    expect(chunkContent(LONG, 'media')).toEqual([LONG])
  })

  // ---- Chunking: long content exercises the policy engine -----------------

  it('record long → token-chunked at 512/0 (plan.overlap=0)', () => {
    const result = chunkContent(LONG, 'record')
    expect(result[0]).toContain('[chunk:512/0]')
  })

  it('tabular long → token-chunked at 768/0', () => {
    const result = chunkContent(LONG, 'tabular')
    expect(result[0]).toContain('[chunk:768/0]')
  })

  it('bi_artifact long → token-chunked at 512/0', () => {
    const result = chunkContent(LONG, 'bi_artifact')
    expect(result[0]).toContain('[chunk:512/0]')
  })

  it('email long → token-chunked at 512/51 (512 × 0.10 = 51)', () => {
    // Math.round(512 * 0.10) = 51
    const result = chunkContent(LONG, 'email')
    expect(result[0]).toContain('[chunk:512/51]')
  })

  it('thread long → token-chunked at 512/77 (512 × 0.15 = 77)', () => {
    // Math.round(512 * 0.15) = 77
    const result = chunkContent(LONG, 'thread')
    expect(result[0]).toContain('[chunk:512/77]')
  })

  it('work_item long → token-chunked at 512/51', () => {
    const result = chunkContent(LONG, 'work_item')
    expect(result[0]).toContain('[chunk:512/51]')
  })

  // ---- Prose: structural for heading-rich content -------------------------

  it('prose long with headings → structural (via splitByHeadings mock)', () => {
    // ~800 tokens per section × 2 = ~1600 tokens total, well above prose noSplitCeiling=600.
    // Two headings / 1600 tokens = headingDensity ≈ 1.25 ≥ 1.0 → structural strategy.
    const mdWithHeadings = '# Title\n\n' + 'word '.repeat(800) + '\n\n## Section\n\n' + 'word '.repeat(800)
    const result = chunkContent(mdWithHeadings, 'prose')
    expect(result[0]).toContain('[structural]')
  })

  it('prose long without headings → token-chunked at 512/51', () => {
    // LONG has no headings → token strategy
    const result = chunkContent(LONG, 'prose')
    expect(result[0]).toContain('[chunk:512/51]')
  })

  // ---- Code: fence-atomic ------------------------------------------------

  it('code long → fence-atomic (via splitFenceAtomic mock)', () => {
    const result = chunkContent(LONG, 'code')
    expect(result[0]).toContain('[fence:')
  })
})

// ── chunkContent: flag OFF ───────────────────────────────────────────────────

describe('chunkContent — flag OFF (legacy provider-string routing)', () => {
  beforeEach(() => { shapeFlagValue = false })

  it('no shape, no provider → default 512/64', () => {
    const result = chunkContent(SHORT, undefined, undefined)
    expect(result[0]).toContain('[chunk:512/64]')
  })

  it('shape present but flag OFF → ignores shape, uses legacy provider', () => {
    // Even though shape='tabular', flag is off so we fall through to legacyProvider
    const result = chunkContent(LONG, 'tabular', 'snowflake')
    // Legacy: TABULAR_SOURCE_TYPES has 'snowflake', len > 4000 → 768/96
    expect(result[0]).toContain('[chunk:768/96]')
  })

  it('legacy provider=gmail → email chunker (char-based, multi-chunk)', () => {
    const emailBody = ('sentence. ').repeat(300) // > 2000 chars → char chunker
    const result = chunkContent(emailBody, undefined, 'gmail')
    expect(result.length).toBeGreaterThan(1)
    result.forEach(c => expect(c.length).toBeLessThanOrEqual(2200))
  })

  it('legacy provider=slack → thread chunker (768/128)', () => {
    const result = chunkContent(SHORT, undefined, 'slack')
    expect(result[0]).toContain('[chunk:768/128]')
  })

  it('legacy provider=hubspot → record passthrough (short content)', () => {
    const result = chunkContent(SHORT, undefined, 'hubspot')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })
})

// ── resolveEmbeddingHint ─────────────────────────────────────────────────────

describe('resolveEmbeddingHint — flag ON', () => {
  beforeEach(() => { shapeFlagValue = true })
  afterEach(() => { shapeFlagValue = false })

  it('record → structured', () => {
    expect(resolveEmbeddingHint('record')).toBe('structured')
  })

  it('prose → document', () => {
    expect(resolveEmbeddingHint('prose')).toBe('document')
  })

  it('email → document', () => {
    expect(resolveEmbeddingHint('email')).toBe('document')
  })

  it('tabular → document', () => {
    expect(resolveEmbeddingHint('tabular')).toBe('document')
  })
})

describe('resolveEmbeddingHint — flag OFF (legacy)', () => {
  beforeEach(() => { shapeFlagValue = false })

  it('legacy provider=hubspot → structured', () => {
    expect(resolveEmbeddingHint(undefined, 'hubspot')).toBe('structured')
  })

  it('legacy provider=salesforce → structured', () => {
    expect(resolveEmbeddingHint(undefined, 'salesforce')).toBe('structured')
  })

  it('legacy provider=slack → document', () => {
    expect(resolveEmbeddingHint(undefined, 'slack')).toBe('document')
  })

  it('no shape, no provider → document', () => {
    expect(resolveEmbeddingHint(undefined, undefined)).toBe('document')
  })
})
