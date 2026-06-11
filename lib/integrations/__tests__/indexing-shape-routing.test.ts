// P1-3 unit tests: shape-based chunkContent + resolveEmbeddingHint
// Verifies flag-on path dispatches by DataShape and flag-off path
// falls back to legacy provider-string routing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Feature flag mock ────────────────────────────────────────────────────────
// We need to control PIPELINE_SHAPE_ROUTING at test time.
// The flag is a module-level const, so we mock the whole module.

let shapeFlagValue = false

vi.mock('@/lib/config/feature-flags', () => ({
  get PIPELINE_SHAPE_ROUTING() { return shapeFlagValue },
}))

// Also mock the chunker so tests run without a full tokenizer
vi.mock('@/lib/langgraph/tools/chunker', () => ({
  chunk: (text: string, opts: { chunkSize: number; overlap: number }) => {
    // Fake chunker: returns single chunk with chunkSize label so tests can assert on it
    return [{ text: `[chunk:${opts.chunkSize}/${opts.overlap}] ${text.slice(0, 20)}` }]
  },
}))

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { chunkContent, resolveEmbeddingHint } from '@/lib/integrations/indexing'

// ── Helpers ──────────────────────────────────────────────────────────────────

const SHORT = 'x'.repeat(100)   // < 3000 chars → record passthrough
const MEDIUM = 'x'.repeat(3500) // > 3000 chars but < 4000 → still within tabular limit
const LONG = 'x'.repeat(4500)   // > 4000 chars → tabular/bi_artifact get chunked

// ── chunkContent: flag ON ────────────────────────────────────────────────────

describe('chunkContent — flag ON', () => {
  beforeEach(() => { shapeFlagValue = true })
  afterEach(() => { shapeFlagValue = false })

  it('record short → single chunk (no split)', () => {
    const result = chunkContent(SHORT, 'record')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })

  it('record long → email-style split (sentence-boundary chunks)', () => {
    const longRecord = ('word '.repeat(1000)).trim() // > 3000 chars
    const result = chunkContent(longRecord, 'record')
    // Each chunk should be ≤ 2200 chars (EMAIL_CHUNK_SIZE_CHARS + slight overshoot)
    expect(result.length).toBeGreaterThan(1)
    result.forEach(c => expect(c.length).toBeLessThanOrEqual(2200))
  })

  it('tabular short → single chunk (≤ 4000)', () => {
    const result = chunkContent(MEDIUM, 'tabular')
    expect(result).toHaveLength(1)
  })

  it('tabular long → token-chunked at 768/96', () => {
    const result = chunkContent(LONG, 'tabular')
    expect(result[0]).toContain('[chunk:768/96]')
  })

  it('bi_artifact long → same as tabular (768/96)', () => {
    const result = chunkContent(LONG, 'bi_artifact')
    expect(result[0]).toContain('[chunk:768/96]')
  })

  it('email → char-based chunker', () => {
    const emailBody = ('sentence. ').repeat(300) // > 2000 chars
    const result = chunkContent(emailBody, 'email')
    expect(result.length).toBeGreaterThan(1)
    result.forEach(c => expect(c.length).toBeLessThanOrEqual(2200))
  })

  it('thread → token-chunked at 768/128', () => {
    const result = chunkContent(SHORT, 'thread')
    expect(result[0]).toContain('[chunk:768/128]')
  })

  it('work_item → token-chunked at 768/128', () => {
    const result = chunkContent(SHORT, 'work_item')
    expect(result[0]).toContain('[chunk:768/128]')
  })

  it('media → single passthrough chunk', () => {
    const result = chunkContent(SHORT, 'media')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(SHORT)
  })

  it('prose → token-chunked at 512/64', () => {
    const result = chunkContent(SHORT, 'prose')
    expect(result[0]).toContain('[chunk:512/64]')
  })

  it('code → token-chunked at 512/64', () => {
    const result = chunkContent(SHORT, 'code')
    expect(result[0]).toContain('[chunk:512/64]')
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

  it('legacy provider=gmail → email chunker', () => {
    const emailBody = ('sentence. ').repeat(300)
    const result = chunkContent(emailBody, undefined, 'gmail')
    expect(result.length).toBeGreaterThan(1)
    result.forEach(c => expect(c.length).toBeLessThanOrEqual(2200))
  })

  it('legacy provider=slack → thread chunker (768/128)', () => {
    const result = chunkContent(SHORT, undefined, 'slack')
    expect(result[0]).toContain('[chunk:768/128]')
  })

  it('legacy provider=hubspot → record passthrough', () => {
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
