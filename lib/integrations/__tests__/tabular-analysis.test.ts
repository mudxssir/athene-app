// ============================================================
// lib/integrations/__tests__/tabular-analysis.test.ts — P4-4
//
// Type-inference hardening: a column is classified by type when ≥95% of its
// non-empty values match (was 100% via every()), so a few stray cells don't
// drop a numeric/date column to varchar and lose its stats.
// ============================================================

import { describe, it, expect, vi } from 'vitest'

// Load-only mocks (the module imports server-only deps transitively).
vi.mock('server-only', () => ({}))
vi.mock('@/lib/langgraph/llm-factory', () => ({ resolveModelClient: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { inferSchema } from '@/lib/integrations/tabular-analysis'

/** Build a single-column rows matrix from cell values. */
function col(values: string[]): string[][] {
  return values.map((v) => [v])
}

describe('inferSchema — 95th-percentile type rule (P4-4)', () => {
  it('classifies a clean numeric column as number', () => {
    const [c] = inferSchema(['amount'], col(['1', '2', '3', '4.5', '6']))
    expect(c.type).toBe('number')
  })

  it('tolerates a single stray non-numeric cell in a long numeric column (was varchar under every())', () => {
    // 49 numbers + 1 "N/A" = 98% numeric ≥ 95% → still number
    const values = Array.from({ length: 49 }, (_, i) => String(i + 1))
    values.push('N/A')
    const [c] = inferSchema(['revenue'], col(values))
    expect(c.type).toBe('number')
  })

  it('falls through to varchar when too many cells are non-numeric (mixed column)', () => {
    // 3 numbers + 2 strings = 60% < 95% → varchar
    const [c] = inferSchema(['mixed'], col(['1', '2', '3', 'foo', 'bar']))
    expect(c.type).toBe('varchar')
  })

  it('small samples require near-unanimity (3 values, 1 bad = 67% < 95% → varchar)', () => {
    const [c] = inferSchema(['tiny'], col(['1', '2', 'x']))
    expect(c.type).toBe('varchar')
  })

  it('classifies an ISO-date column as date, tolerating one bad cell', () => {
    const values = [
      '2026-01-01', '2026-02-15', '2026-03-20', '2026-04-30',
      '2026-05-05', '2026-06-06', '2026-07-07', '2026-08-08',
      '2026-09-09', 'unknown', // 9/10 = 90%... below threshold
    ]
    // 90% < 95% → NOT date
    expect(inferSchema(['d'], col(values))[0].type).toBe('varchar')
    // add more clean dates so the bad cell is <5%
    const clean = Array.from({ length: 20 }, (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`)
    clean.push('unknown') // 20/21 = 95.2% ≥ 95% → date
    expect(inferSchema(['d'], col(clean))[0].type).toBe('date')
  })

  it('does NOT classify short numeric tokens (zip/IDs) as date', () => {
    const [c] = inferSchema(['zip'], col(['1001', '2002', '3003', '4004', '5005']))
    // these parse as numbers (length ≤ 4 guard also blocks date) → number
    expect(c.type).toBe('number')
  })

  it('empty column → varchar', () => {
    const [c] = inferSchema(['blank'], col(['', '', '']))
    expect(c.type).toBe('varchar')
  })

  it('uses fallback name col_N for blank headers', () => {
    const schema = inferSchema(['', 'named'], [['1', 'a'], ['2', 'b']])
    expect(schema[0].name).toBe('col_1')
    expect(schema[1].name).toBe('named')
  })
})
