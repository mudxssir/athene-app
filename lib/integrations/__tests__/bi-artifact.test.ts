// ============================================================
// lib/integrations/__tests__/bi-artifact.test.ts — P4-5
//
// fenceCode wraps query-language bodies in a code fence; selectStrategy routes a
// fence-heavy bi_artifact (DAX/LookML/SQL) to fence-atomic chunking.
// ============================================================

import { describe, it, expect } from 'vitest'
import { fenceCode } from '@/lib/integrations/bi-artifact'
import { computeSignals, selectStrategy } from '@/lib/indexing/chunk-policy'

describe('fenceCode (P4-5)', () => {
  it('wraps a DAX expression in a labeled fence, verbatim', () => {
    const dax = 'CALCULATE(\n  SUM(Sales[Amount]),\n  Sales[Region] = "EMEA"\n)'
    const out = fenceCode('dax', dax)
    expect(out).toBe('```dax\n' + dax + '\n```')
    // The body survives byte-identical (operators/indentation).
    expect(out).toContain('SUM(Sales[Amount])')
    expect(out).toContain('  Sales[Region] = "EMEA"')
  })

  it('returns empty string for blank input (caller drops the line)', () => {
    expect(fenceCode('sql', '')).toBe('')
    expect(fenceCode('sql', null)).toBe('')
    expect(fenceCode('sql', '   ')).toBe('')
  })
})

describe('selectStrategy — fence-heavy bi_artifact → fence-atomic (P4-5)', () => {
  it('a DAX-heavy bi_artifact chunk above the no-split ceiling chunks fence-atomically', () => {
    // Build a long fenced DAX body so codeFenceRatio > 0.3 AND tokens exceed the
    // bi_artifact no-split ceiling (else passthrough wins first).
    const daxLines = Array.from(
      { length: 400 },
      (_, i) => `VAR regionTotal_${i} = CALCULATE(SUM(Sales[Amount]), Sales[Region] = "Region_${i}", Sales[Year] = 2026)`,
    ).join('\n')
    const content = 'Measure: Big\nDataset: Sales\n\n```dax\n' + daxLines + '\n```'
    const signals = computeSignals(content)
    expect(signals.codeFenceRatio).toBeGreaterThan(0.3)
    expect(signals.tokens).toBeGreaterThan(800) // above the bi_artifact ceiling

    const plan = selectStrategy('bi_artifact', signals)
    expect(plan.strategy).toBe('fence-atomic')
  })

  it('a small bi_artifact (below no-split ceiling) stays passthrough', () => {
    const signals = computeSignals('Dashboard: Q3 KPIs\nWorkspace: Sales')
    const plan = selectStrategy('bi_artifact', signals)
    expect(plan.strategy).toBe('passthrough')
  })

  it('a prose-only bi_artifact above ceiling does NOT force fence-atomic', () => {
    const prose = Array.from({ length: 200 }, () => 'This dashboard tracks revenue trends across regions.').join(' ')
    const signals = computeSignals(prose)
    expect(signals.codeFenceRatio).toBe(0)
    const plan = selectStrategy('bi_artifact', signals)
    expect(plan.strategy).not.toBe('fence-atomic')
  })
})
