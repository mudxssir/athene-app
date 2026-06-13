// ============================================================
// lib/integrations/__tests__/vocab-enrichment.test.ts — P4-2
//
// Vocabulary enrichment: schema-hash stability, cache-first behavior (one LLM
// call per distinct schema), sanitization, fail-open. resolveModelClient +
// supabaseAdmin are mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { invokeMock, cacheState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  cacheState: { row: null as null | { alias_line: string }, upserts: [] as unknown[] },
}))

// Flag ON for this file.
vi.mock('@/lib/config/feature-flags', () => ({ TABULAR_VOCAB_ENRICHMENT: true }))
vi.mock('@/lib/langgraph/llm-factory', () => ({
  resolveModelClient: vi.fn(async () => ({ invoke: invokeMock })),
}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: cacheState.row, error: null }) }) }) }),
      upsert: (row: unknown) => { cacheState.upserts.push(row); return Promise.resolve({ error: null }) },
    }),
  },
}))

import { enrichVocabulary, schemaHash, sanitizeAliasLine } from '@/lib/integrations/vocab-enrichment'

const schema = [
  { name: 'amount', type: 'number' },
  { name: 'geo', type: 'varchar' },
]

beforeEach(() => {
  vi.clearAllMocks()
  cacheState.row = null
  cacheState.upserts = []
})

describe('schemaHash (P4-2)', () => {
  it('is stable regardless of column order and case', () => {
    const a = schemaHash([{ name: 'Amount', type: 'Number' }, { name: 'geo', type: 'varchar' }])
    const b = schemaHash([{ name: 'geo', type: 'VARCHAR' }, { name: 'amount', type: 'number' }])
    expect(a).toBe(b)
  })
  it('differs when a column type changes', () => {
    expect(schemaHash([{ name: 'x', type: 'number' }])).not.toBe(schemaHash([{ name: 'x', type: 'varchar' }]))
  })
})

describe('sanitizeAliasLine (P4-2)', () => {
  it('single-lines, strips URLs, clamps length', () => {
    expect(sanitizeAliasLine('revenue → amount,\n region → geo  see http://x.test/y')).toBe(
      'revenue → amount, region → geo see',
    )
    expect(sanitizeAliasLine('x'.repeat(700)).length).toBe(600)
  })
})

describe('enrichVocabulary (P4-2)', () => {
  it('cache miss → calls LLM, writes the cache, returns the alias line', async () => {
    invokeMock.mockResolvedValue({ content: 'revenue → amount, region → geo' })
    const out = await enrichVocabulary('sales.orders', schema, 'org-1')
    expect(out).toBe('revenue → amount, region → geo')
    expect(invokeMock).toHaveBeenCalledOnce()
    expect(cacheState.upserts).toHaveLength(1)
    expect((cacheState.upserts[0] as Record<string, unknown>).schema_hash).toBe(schemaHash(schema))
  })

  it('cache hit → returns cached line WITHOUT calling the LLM', async () => {
    cacheState.row = { alias_line: 'cached → line' }
    const out = await enrichVocabulary('sales.orders', schema, 'org-1')
    expect(out).toBe('cached → line')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('folds column comments into the prompt when supplied', async () => {
    invokeMock.mockResolvedValue({ content: 'revenue → amount' })
    await enrichVocabulary('t', schema, 'org-1', { amount: 'gross sale value in USD' })
    const prompt = invokeMock.mock.calls[0][0][0].content
    expect(prompt).toContain('amount (number) — gross sale value in USD')
  })

  it('returns null without orgId or empty schema (no LLM call)', async () => {
    expect(await enrichVocabulary('t', schema)).toBeNull()
    expect(await enrichVocabulary('t', [], 'org-1')).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('fail-open: LLM throws → null, no cache write', async () => {
    invokeMock.mockRejectedValue(new Error('rate limited'))
    expect(await enrichVocabulary('t', schema, 'org-1')).toBeNull()
    expect(cacheState.upserts).toHaveLength(0)
  })
})
