// ============================================================
// lib/ai/__tests__/sovereignty-prefix.test.ts — P7-2
//
// The sovereignty embedding lane's prefix-task mapping (nomic/BGE/TEI use a text
// prefix to signal the retrieval task, not an API `task` param). Asymmetric
// retrieval correctness: queries get `search_query: `, passages `search_document: `.
// ============================================================

import { describe, it, expect } from 'vitest'
import { applyPrefixTask } from '@/lib/ai/embedding-factory'

describe('applyPrefixTask (P7-2 sovereignty lane)', () => {
  it('prefixes queries with search_query:', () => {
    expect(applyPrefixTask(['who owns billing?'], 'query')).toEqual(['search_query: who owns billing?'])
  })

  it('prefixes documents/passages with search_document:', () => {
    expect(applyPrefixTask(['The billing service is owned by Dana.'], 'document'))
      .toEqual(['search_document: The billing service is owned by Dana.'])
  })

  it('treats structured (and undefined hint) as document', () => {
    expect(applyPrefixTask(['row: amount=50000'], 'structured')).toEqual(['search_document: row: amount=50000'])
    expect(applyPrefixTask(['x'], undefined)).toEqual(['search_document: x'])
  })

  it('preserves order and prefixes every text in the batch', () => {
    const out = applyPrefixTask(['a', 'b', 'c'], 'query')
    expect(out).toEqual(['search_query: a', 'search_query: b', 'search_query: c'])
  })

  it('is idempotent — never double-prefixes an already-tagged text', () => {
    expect(applyPrefixTask(['search_query: a'], 'query')).toEqual(['search_query: a'])
    expect(applyPrefixTask(['search_document: a'], 'document')).toEqual(['search_document: a'])
    // Even if the hint disagrees with an existing prefix, we don't stack prefixes.
    expect(applyPrefixTask(['search_document: a'], 'query')).toEqual(['search_document: a'])
  })

  it('asymmetric: the same text gets different vectors-worthy prefixes by role', () => {
    const text = 'API Gateway dependency'
    expect(applyPrefixTask([text], 'query')[0]).not.toBe(applyPrefixTask([text], 'document')[0])
  })
})
