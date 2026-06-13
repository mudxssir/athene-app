// ============================================================
// lib/integrations/__tests__/tabular-pii-wide.test.ts — P4-3
//
// PII masking on tabular sample/stats values (flag-gated) + wide-table
// column-group sectioning with table-name header re-emit.
// ============================================================

import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/langgraph/llm-factory', () => ({ resolveModelClient: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

// Flag ON for this file so masking is exercised.
vi.mock('@/lib/config/feature-flags', () => ({ TABULAR_PII_MASKING: true }))

import { maskPII, buildSampleChunk } from '@/lib/integrations/bi-chunking'

describe('maskPII (P4-3, flag ON)', () => {
  it('masks emails, SSNs, and phone numbers', () => {
    expect(maskPII('contact bob@acme.com')).toBe('contact ***')
    expect(maskPII('ssn 123-45-6789')).toBe('ssn ***')
    expect(maskPII('call (415) 555-2671')).toBe('call ***')
    expect(maskPII('415-555-2671')).toBe('***')
  })

  it('leaves non-PII values intact', () => {
    expect(maskPII('EMEA')).toBe('EMEA')
    expect(maskPII('1200')).toBe('1200')
    expect(maskPII('2026-01-01')).toBe('2026-01-01')
  })

  it('masks multiple tokens in one value', () => {
    expect(maskPII('a@b.com / 123-45-6789')).toBe('*** / ***')
  })
})

describe('buildSampleChunk — PII masking applied to rendered rows (flag ON)', () => {
  it('masks email/phone cell values in the sample content', () => {
    const schema = [
      { name: 'name', type: 'varchar' },
      { name: 'email', type: 'varchar' },
      { name: 'phone', type: 'varchar' },
    ]
    const rows = [
      { name: 'Alice', email: 'alice@acme.com', phone: '415-555-2671' },
      { name: 'Bob', email: 'bob@acme.com', phone: '415-555-9999' },
    ]
    const chunk = buildSampleChunk('crm.contacts', schema, rows, 'upload', 'https://x')
    expect(chunk.content).not.toContain('@acme.com')
    expect(chunk.content).not.toContain('415-555-2671')
    expect(chunk.content).toContain('***')
    // Non-PII values survive.
    expect(chunk.content).toContain('Alice')
  })
})

describe('buildSampleChunk — wide-table column grouping (>30 cols)', () => {
  it('segments rows into 30-col groups, each re-emitting the table-name header', () => {
    const schema = Array.from({ length: 65 }, (_, i) => ({ name: `c${i}`, type: 'varchar' }))
    const row: Record<string, string> = {}
    schema.forEach((c, i) => { row[c.name] = `v${i}` })
    const chunk = buildSampleChunk('warehouse.wide', schema, [row], 'snowflake', 'https://x')

    // 65 cols → groups of 30 → 3 group headers (1-30, 31-60, 61-65).
    expect(chunk.content).toContain('[warehouse.wide cols 1-30]')
    expect(chunk.content).toContain('[warehouse.wide cols 31-60]')
    expect(chunk.content).toContain('[warehouse.wide cols 61-65]')
    // All columns are still present across the groups.
    expect(chunk.content).toContain('c0: v0')
    expect(chunk.content).toContain('c64: v64')
  })

  it('narrow tables (≤30 cols) render without column-group headers (back-compat)', () => {
    const schema = [{ name: 'a', type: 'varchar' }, { name: 'b', type: 'number' }]
    const chunk = buildSampleChunk('t', schema, [{ a: 'x', b: '1' }], 'snowflake', 'https://x')
    expect(chunk.content).not.toContain('cols 1-')
    expect(chunk.content).toContain('a: x')
  })
})
