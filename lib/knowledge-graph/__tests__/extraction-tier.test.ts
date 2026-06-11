// P1-4 unit tests: extractionTier(shape, chunkTexts)
// Verifies shape-to-tier mapping and Tier B gating logic.

import { describe, it, expect } from 'vitest'
import { extractionTier } from '@/lib/knowledge-graph/extraction-gate'

const EMPTY: string[] = []
const NO_SIGNAL = ['this is a routine update with no blockers or decisions']
const WITH_SIGNAL = ['we decided to postpone the launch until Q3']
const LONG_TEXT = ['x'.repeat(300)] // > 200 chars → record promoted to A
const SHORT_TEXT = ['x'.repeat(50)]  // < 200 chars → record stays B

// ── Tier A shapes (always extract) ───────────────────────────────────────────

describe('extractionTier: Tier A shapes', () => {
  it('prose → A regardless of text', () => {
    expect(extractionTier('prose', EMPTY)).toBe('A')
    expect(extractionTier('prose', NO_SIGNAL)).toBe('A')
  })

  it('email → A regardless of text', () => {
    expect(extractionTier('email', EMPTY)).toBe('A')
    expect(extractionTier('email', WITH_SIGNAL)).toBe('A')
  })

  it('work_item → A regardless of text', () => {
    expect(extractionTier('work_item', NO_SIGNAL)).toBe('A')
  })
})

// ── Tier B shapes (gated) ─────────────────────────────────────────────────────

describe('extractionTier: thread (signal-gated)', () => {
  it('thread with no signal → B', () => {
    expect(extractionTier('thread', NO_SIGNAL)).toBe('B')
  })

  it('thread with empty texts → B', () => {
    expect(extractionTier('thread', EMPTY)).toBe('B')
  })

  it('thread with decision signal → promoted to A', () => {
    expect(extractionTier('thread', WITH_SIGNAL)).toBe('A')
  })

  it('thread: signal in one of many chunks promotes to A', () => {
    expect(extractionTier('thread', [...NO_SIGNAL, ...WITH_SIGNAL])).toBe('A')
  })

  it('thread: blocker signal promotes to A', () => {
    expect(extractionTier('thread', ['this is blocked by infra team'])).toBe('A')
  })
})

describe('extractionTier: record (description-length gated)', () => {
  it('record with short texts (< 200 chars each) → B', () => {
    expect(extractionTier('record', SHORT_TEXT)).toBe('B')
  })

  it('record with empty texts → B', () => {
    expect(extractionTier('record', EMPTY)).toBe('B')
  })

  it('record with one text > 200 chars → promoted to A', () => {
    expect(extractionTier('record', LONG_TEXT)).toBe('A')
  })

  it('record: any long chunk among short ones promotes to A', () => {
    expect(extractionTier('record', [...SHORT_TEXT, ...LONG_TEXT])).toBe('A')
  })
})

// ── Tier C shapes (never extract) ─────────────────────────────────────────────

describe('extractionTier: Tier C shapes', () => {
  it('tabular → C regardless of text', () => {
    expect(extractionTier('tabular', WITH_SIGNAL)).toBe('C')
    expect(extractionTier('tabular', EMPTY)).toBe('C')
  })

  it('bi_artifact → C', () => {
    expect(extractionTier('bi_artifact', WITH_SIGNAL)).toBe('C')
  })

  it('media → C', () => {
    expect(extractionTier('media', LONG_TEXT)).toBe('C')
  })

  it('code → C', () => {
    expect(extractionTier('code', WITH_SIGNAL)).toBe('C')
  })
})
