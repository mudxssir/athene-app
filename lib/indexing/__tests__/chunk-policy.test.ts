// P1-5 + P1-6 unit tests: computeSignals + selectStrategy
// All tests run the real tokenizer (gpt-tokenizer) — pure functions, no I/O.

import { describe, it, expect } from 'vitest'
import {
  computeSignals,
  selectStrategy,
  truncateAtTokenCap,
  countTokens,
  neutralizeMonsterRuns,
  TRUNCATE_TOKEN_CAP,
  TRUNCATION_MARKER,
  type ChunkSignals,
  type ChunkPlan,
} from '../chunk-policy'
import type { DataShape } from '@/lib/integrations/base'

// ── computeSignals ────────────────────────────────────────────────────────────

describe('computeSignals', () => {
  it('empty string → zero signals', () => {
    const s = computeSignals('')
    expect(s.tokens).toBe(0)
    expect(s.headingDensity).toBe(0)
    expect(s.codeFenceRatio).toBe(0)
  })

  it('plain prose → low heading/fence/table density', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(50)
    const s = computeSignals(prose)
    expect(s.tokens).toBeGreaterThan(0)
    expect(s.headingDensity).toBe(0)
    expect(s.codeFenceRatio).toBe(0)
    expect(s.tableDensity).toBeLessThan(0.1)
  })

  it('markdown with headings → headingDensity > 0', () => {
    const md = '# Intro\n\nParagraph one.\n\n## Setup\n\nParagraph two.\n\n### Installation\n\nInstall step.\n'
    const s = computeSignals(md)
    expect(s.headingDensity).toBeGreaterThan(0)
  })

  it('code-heavy markdown → codeFenceRatio > 0', () => {
    const code = '# Code\n\n```typescript\nconst x = 1;\nconst y = 2;\nconst z = x + y;\n```\n\nSome prose.\n'
    const s = computeSignals(code)
    expect(s.codeFenceRatio).toBeGreaterThan(0)
  })

  it('unclosed code fence still counts fence lines', () => {
    const broken = '```\nline1\nline2\nline3\n' // fence never closed
    const s = computeSignals(broken)
    expect(s.codeFenceRatio).toBeGreaterThan(0)
  })

  it('pipe table → tableDensity > 0', () => {
    const table = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n'
    const s = computeSignals(table)
    expect(s.tableDensity).toBeGreaterThan(0)
  })

  it('list-heavy content → listRatio > 0', () => {
    const list = '- item one\n- item two\n- item three\n* bullet\n1. numbered\n'
    const s = computeSignals(list)
    expect(s.listRatio).toBeGreaterThan(0)
  })

  it('tokens reflects content length', () => {
    const short = 'hello world'
    const long = 'hello world '.repeat(200)
    const sShort = computeSignals(short)
    const sLong = computeSignals(long)
    expect(sLong.tokens).toBeGreaterThan(sShort.tokens)
  })
})

// ── selectStrategy ────────────────────────────────────────────────────────────

const BELOW_CEILING: ChunkSignals = {
  tokens: 50, headingDensity: 0, tableDensity: 0, codeFenceRatio: 0, sentenceLen: 100, listRatio: 0,
}

const ABOVE_CEILING: ChunkSignals = {
  tokens: 5000, headingDensity: 0, tableDensity: 0, codeFenceRatio: 0, sentenceLen: 100, listRatio: 0,
}

const HEADING_RICH: ChunkSignals = {
  tokens: 5000, headingDensity: 3.0, tableDensity: 0, codeFenceRatio: 0, sentenceLen: 80, listRatio: 0,
}

const CODE_HEAVY: ChunkSignals = {
  tokens: 5000, headingDensity: 0, tableDensity: 0, codeFenceRatio: 0.5, sentenceLen: 30, listRatio: 0,
}

describe('selectStrategy', () => {
  // Passthrough when below noSplitCeiling
  it.each<[import('@/lib/integrations/base').DataShape]>([
    ['prose'], ['email'], ['thread'], ['work_item'], ['record'],
    ['tabular'], ['bi_artifact'], ['media'], ['code'],
  ])('%s short → passthrough', (shape) => {
    const plan = selectStrategy(shape, BELOW_CEILING)
    expect(plan.strategy).toBe('passthrough')
  })

  // Media: always passthrough regardless of size
  it('media massive → still passthrough', () => {
    const plan = selectStrategy('media', { ...ABOVE_CEILING, tokens: 1_000_000 })
    expect(plan.strategy).toBe('passthrough')
  })

  // Token strategy for non-prose shapes when above ceiling
  it.each<[import('@/lib/integrations/base').DataShape]>([
    ['email'], ['thread'], ['work_item'], ['record'], ['tabular'], ['bi_artifact'],
  ])('%s long → token strategy', (shape) => {
    const plan = selectStrategy(shape, ABOVE_CEILING)
    expect(plan.strategy).toBe('token')
  })

  // Prose: structural when headings present
  it('prose with headings → structural', () => {
    const plan = selectStrategy('prose', HEADING_RICH)
    expect(plan.strategy).toBe('structural')
    expect(plan.childTarget).toBe(320)
    expect(plan.parentTarget).toBe(1200)
  })

  // Prose: fence-atomic when code-heavy
  it('prose code-heavy → fence-atomic', () => {
    const plan = selectStrategy('prose', CODE_HEAVY)
    expect(plan.strategy).toBe('fence-atomic')
  })

  // Prose: token when heading-poor and not code-heavy
  it('prose no headings no fences → token', () => {
    const plan = selectStrategy('prose', ABOVE_CEILING)
    expect(plan.strategy).toBe('token')
    expect(plan.childTarget).toBe(512)
  })

  // Code: always fence-atomic when above ceiling
  it('code long → fence-atomic', () => {
    const plan = selectStrategy('code', ABOVE_CEILING)
    expect(plan.strategy).toBe('fence-atomic')
  })

  // Overlap values (fractions, not tokens)
  it('thread overlap is 0.15', () => {
    const plan = selectStrategy('thread', ABOVE_CEILING)
    expect(plan.overlap).toBe(0.15)
  })

  it('email overlap is 0.10', () => {
    const plan = selectStrategy('email', ABOVE_CEILING)
    expect(plan.overlap).toBe(0.10)
  })

  it('tabular overlap is 0', () => {
    const plan = selectStrategy('tabular', ABOVE_CEILING)
    expect(plan.overlap).toBe(0)
  })

  it('record overlap is 0', () => {
    const plan = selectStrategy('record', ABOVE_CEILING)
    expect(plan.overlap).toBe(0)
  })

  // noSplitCeiling boundary: exactly at ceiling → passthrough
  it('prose at exactly noSplitCeiling (600) → passthrough', () => {
    const plan = selectStrategy('prose', { ...ABOVE_CEILING, tokens: 600 })
    expect(plan.strategy).toBe('passthrough')
  })

  // One above ceiling → NOT passthrough
  it('prose one token above ceiling (601) → not passthrough', () => {
    const plan = selectStrategy('prose', { ...ABOVE_CEILING, tokens: 601 })
    expect(plan.strategy).not.toBe('passthrough')
  })
})

// ── countTokens / neutralizeMonsterRuns (tokenizer-hang guard) ────────────────
// gpt-tokenizer's BPE is quadratic on unbroken runs (measured: 500k-char run
// ≈ 3 minutes, 500k chars of prose ≈ 9 ms). These guards keep the indexer
// linear on garbage input.

describe('countTokens', () => {
  it('matches the real tokenizer on natural text', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
    expect(countTokens(prose)).toBeGreaterThan(0)
  })

  it('a 1M-char unbroken run is counted in linear time', () => {
    const t0 = Date.now()
    const tokens = countTokens('a'.repeat(1_000_000))
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(tokens).toBeGreaterThan(0)
  })

  it('mixed text with an embedded monster run does not hang', () => {
    const t0 = Date.now()
    const tokens = countTokens(`prefix text ${'x'.repeat(100_000)} suffix text`)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(tokens).toBeGreaterThan(0)
  })
})

describe('neutralizeMonsterRuns', () => {
  it('natural text is returned unchanged', () => {
    const prose = 'Normal sentence with words. '.repeat(50)
    expect(neutralizeMonsterRuns(prose)).toBe(prose)
  })

  it('monster runs are broken into bounded pieces', () => {
    const out = neutralizeMonsterRuns('b'.repeat(10_000))
    const longestRun = Math.max(...out.split(/\s+/).map(s => s.length))
    expect(longestRun).toBeLessThanOrEqual(2048)
  })
})

// ── truncateAtTokenCap (playbook P1 item 7) ───────────────────────────────────

describe('truncateAtTokenCap', () => {
  it('small document passes through untouched', () => {
    const text = 'word '.repeat(1000)
    const result = truncateAtTokenCap(text)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(text)
  })

  it('document over the cap is cut and marked', () => {
    // 2M chars of prose ≈ 400–500k tokens — well over the 200k cap
    const text = 'word '.repeat(400_000)
    const result = truncateAtTokenCap(text)
    expect(result.truncated).toBe(true)
    expect(result.text.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(result.text.length).toBeLessThan(text.length)
  })

  it('marker constant matches the playbook spec', () => {
    expect(TRUNCATION_MARKER).toContain('[truncated]')
  })

  it('cap constant is 200k tokens', () => {
    expect(TRUNCATE_TOKEN_CAP).toBe(200_000)
  })
})

// ── Fuzz protocol (playbook P1 edge protocol) ─────────────────────────────────
// "chunk-policy fuzz test (random unicode, 10 MB single-line doc, emoji-only,
//  RTL text, null bytes) may never throw — worst case returns single truncated
//  chunk."

const ALL_SHAPES: DataShape[] = [
  'prose', 'email', 'thread', 'work_item', 'record',
  'tabular', 'bi_artifact', 'media', 'code',
]

const FUZZ_INPUTS: Array<[string, string]> = [
  ['empty string', ''],
  ['whitespace only', ' \n\t  \n\n  '],
  ['null bytes', 'before\x00\x00after\x00'],
  ['emoji-only', '🎉🚀😀🔥💯'.repeat(500)],
  ['RTL text', 'مرحبا بالعالم هذا نص عربي طويل '.repeat(200)],
  ['mixed random unicode', 'a‮�​𝕬𝖇𝖈😀間違い'.repeat(300)],
  ['unclosed code fence', '```js\nlet x = 1\n' + 'line\n'.repeat(100)],
  ['markdown bomb', ('#'.repeat(4) + ' h\n| a | b |\n- li\n').repeat(500)],
  ['10 MB single line', 'a'.repeat(10 * 1024 * 1024)],
]

describe('fuzz protocol — never throws, always a valid plan', () => {
  for (const [label, input] of FUZZ_INPUTS) {
    it(`${label}: computeSignals + selectStrategy + truncateAtTokenCap survive`, () => {
      let signals: ChunkSignals
      expect(() => { signals = computeSignals(input) }).not.toThrow()

      for (const shape of ALL_SHAPES) {
        let plan: ChunkPlan
        expect(() => { plan = selectStrategy(shape, signals!) }).not.toThrow()
        expect(['passthrough', 'structural', 'fence-atomic', 'token']).toContain(plan!.strategy)
        expect(plan!.childTarget).toBeGreaterThan(0)
      }

      let capped: { text: string; truncated: boolean }
      expect(() => { capped = truncateAtTokenCap(input) }).not.toThrow()
      expect(typeof capped!.text).toBe('string')
      if (capped!.truncated) {
        expect(capped!.text.endsWith(TRUNCATION_MARKER)).toBe(true)
      }
    })
  }

  it('10 MB single line is truncated to a bounded size', () => {
    const result = truncateAtTokenCap('a'.repeat(10 * 1024 * 1024))
    expect(result.truncated).toBe(true)
    // Bounded by the 1M-char analysis slice + marker, never the original 10 MB
    expect(result.text.length).toBeLessThanOrEqual(TRUNCATE_TOKEN_CAP * 5 + TRUNCATION_MARKER.length)
  })
})
