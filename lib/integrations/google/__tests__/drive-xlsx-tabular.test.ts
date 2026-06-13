// ============================================================
// lib/integrations/google/__tests__/drive-xlsx-tabular.test.ts
//
// P3-3 / audit D7: Drive .xlsx workbooks must route through the tabular engine
// (stats/sample/agg chunks, Tier C deterministic) instead of flat 512-token
// prose windows. This covers the deterministic core — parseXlsxBufferToTables —
// and its handoff to tabularChunksFromParsed (the same engine native Google
// Sheets and uploads use).
// ============================================================

import { vi, describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'

// api-client is imported transitively by drive-fetcher; stub it so the module
// loads without real network bindings. These tests never hit it.
vi.mock('@/lib/integrations/google/api-client', () => ({
  googleFetch: vi.fn(),
  googleFetchRaw: vi.fn(),
}))

import { parseXlsxBufferToTables } from '@/lib/integrations/google/drive-fetcher'
import { tabularChunksFromParsed } from '@/lib/integrations/tabular-analysis'

/** Build an .xlsx Buffer from one or more named sheets (array-of-arrays). */
function xlsxBuffer(sheets: Record<string, string[][]>): Buffer {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

describe('D7 — parseXlsxBufferToTables', () => {
  it('produces one ParsedTable per sheet with headers + data rows', () => {
    const buf = xlsxBuffer({
      Revenue: [
        ['region', 'amount'],
        ['EMEA', '1200'],
        ['US', '3400'],
      ],
      Costs: [
        ['team', 'spend'],
        ['Platform', '500'],
      ],
    })

    const tables = parseXlsxBufferToTables(buf)

    expect(tables).toHaveLength(2)
    const revenue = tables.find((t) => t.tableName === 'Revenue')!
    expect(revenue.headers).toEqual(['region', 'amount'])
    expect(revenue.rows).toEqual([
      ['EMEA', '1200'],
      ['US', '3400'],
    ])
    const costs = tables.find((t) => t.tableName === 'Costs')!
    expect(costs.rows).toEqual([['Platform', '500']])
  })

  it('skips header-only and empty sheets (no spurious tables)', () => {
    const buf = xlsxBuffer({
      HeaderOnly: [['a', 'b']], // header but no data → skipped
      Empty: [], // nothing → skipped
      Real: [
        ['x', 'y'],
        ['1', '2'],
      ],
    })

    const tables = parseXlsxBufferToTables(buf)
    expect(tables.map((t) => t.tableName)).toEqual(['Real'])
  })

  it('blank-fills missing header cells and drops all-blank rows', () => {
    const buf = xlsxBuffer({
      Sheet1: [
        ['name', ''], // second header blank → col_2
        ['Alice', 'x'],
        ['', ''], // all-blank → dropped
        ['Bob', 'y'],
      ],
    })

    const [table] = parseXlsxBufferToTables(buf)
    expect(table.headers).toEqual(['name', 'col_2'])
    expect(table.rows).toEqual([
      ['Alice', 'x'],
      ['Bob', 'y'],
    ])
  })

  it('returns [] on a non-xlsx / corrupt buffer (caller surfaces a skip)', () => {
    expect(parseXlsxBufferToTables(Buffer.from('not a workbook'))).toEqual([])
  })

  it('end-to-end: xlsx buffer → tabular chunks (stats/sample), not prose', async () => {
    const buf = xlsxBuffer({
      Deals: [
        ['stage', 'value'],
        ['Won', '5000'],
        ['Lost', '0'],
        ['Open', '2500'],
      ],
    })
    const tables = parseXlsxBufferToTables(buf)

    const chunks = await tabularChunksFromParsed(
      tables,
      'drive:file-123',
      'Deals.xlsx',
      'https://drive.google.com/file/d/file-123',
      { withLlmAnalysis: false, provider: 'google_drive_tabular' },
    )

    // Deterministic stats + sample chunks with stable, idempotent chunk_ids.
    const ids = chunks.map((c) => c.chunk_id)
    expect(ids).toContain('drive:file-123:stats')
    expect(ids).toContain('drive:file-123:sample')
    // None of them are the old flat 'prose' chunk.
    expect(chunks.every((c) => c.shape !== 'prose')).toBe(true)
    expect(chunks.every((c) => c.metadata.provider === 'google_drive_tabular')).toBe(true)
  })
})
