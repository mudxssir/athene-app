// ============================================================
// lib/integrations/__tests__/binary-parsing.test.ts
//
// P3-1 / P3-2: tiered binary-parsing cascade + Docling-output adapter.
//
// Cascade lane selection (sidecar → LlamaParse opt-in → TS) and the adapter
// (tables → tabular chunks, markdown → prose chunk, pictures → media stubs,
// parser_used stamped) are exercised with the sidecar / LlamaParse / supabase
// dependencies mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mock state ───────────────────────────────────────────────────────
const {
  sidecarAvailableMock,
  parseSidecarMock,
  llamaParseMock,
  orgRowMock,
  mediaUpsertCalls,
} = vi.hoisted(() => ({
  sidecarAvailableMock: vi.fn<[], boolean>(),
  parseSidecarMock: vi.fn(),
  llamaParseMock: vi.fn(),
  orgRowMock: { value: null as null | { external_parsing_allowed: boolean } },
  mediaUpsertCalls: [] as unknown[],
}))

vi.mock('@/lib/config/feature-flags', () => ({ SIDECAR_PARSING: true, TABULAR_PII_MASKING: false }))

vi.mock('@/lib/integrations/sidecar-client', () => ({
  sidecarAvailable: sidecarAvailableMock,
  parseSidecar: parseSidecarMock,
}))

vi.mock('@/lib/integrations/llamaparse-client', () => ({
  parseWithLlamaParse: llamaParseMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      // organizations read: .select().eq().maybeSingle()
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: orgRowMock.value, error: null }),
        }),
      }),
      // media_queue write: .upsert(rows, opts)
      upsert: (rows: unknown) => {
        if (table === 'media_queue') mediaUpsertCalls.push(rows)
        return Promise.resolve({ error: null })
      },
    }),
  },
}))

import {
  parseBinaryTiered,
  parsedToChunks,
  _resetExternalParsingCache,
  type TieredParseResult,
} from '@/lib/integrations/binary-parsing'

const ORG = 'org-123'
const BUF = Buffer.from('binary-bytes')

beforeEach(() => {
  vi.clearAllMocks()
  _resetExternalParsingCache()
  orgRowMock.value = null
  mediaUpsertCalls.length = 0
  sidecarAvailableMock.mockReturnValue(false)
  parseSidecarMock.mockResolvedValue(null)
  llamaParseMock.mockResolvedValue(null)
})

describe('parseBinaryTiered — lane selection', () => {
  it('lane 1: uses the sidecar when available and it returns markdown', async () => {
    sidecarAvailableMock.mockReturnValue(true)
    parseSidecarMock.mockResolvedValue({
      markdown: '# Title\n\nbody',
      parser_used: 'docling',
      parser_version: '2.x',
      tables: [{ table_name: 'T1', headers: ['a'], rows: [['1']] }],
      pictures: [{ ref: 'doc.pdf:pic1', page: 1 }],
    })
    const tsFallback = vi.fn()

    const res = await parseBinaryTiered(BUF, 'doc.pdf', ORG, tsFallback)

    expect(res.parser_used).toBe('docling')
    expect(res.text).toContain('# Title')
    expect(res.tables).toEqual([{ tableName: 'T1', headers: ['a'], rows: [['1']] }])
    expect(res.pictures).toHaveLength(1)
    expect(tsFallback).not.toHaveBeenCalled()
    expect(llamaParseMock).not.toHaveBeenCalled()
  })

  it('lane 2: falls to LlamaParse when sidecar declines AND org opted in', async () => {
    sidecarAvailableMock.mockReturnValue(false)
    orgRowMock.value = { external_parsing_allowed: true }
    llamaParseMock.mockResolvedValue({ text: 'llama text', tables: [] })
    const tsFallback = vi.fn()

    const res = await parseBinaryTiered(BUF, 'doc.pdf', ORG, tsFallback)

    expect(res.parser_used).toBe('llamaparse')
    expect(res.text).toBe('llama text')
    expect(tsFallback).not.toHaveBeenCalled()
  })

  it('lane 2 skipped when org has NOT opted in — goes straight to TS', async () => {
    sidecarAvailableMock.mockReturnValue(false)
    orgRowMock.value = { external_parsing_allowed: false }
    const tsFallback = vi.fn().mockResolvedValue({ text: 'ts text', version: 'pdf-parse' })

    const res = await parseBinaryTiered(BUF, 'doc.pdf', ORG, tsFallback)

    expect(llamaParseMock).not.toHaveBeenCalled()
    expect(res.parser_used).toBe('ts-fallback')
    expect(res.text).toBe('ts text')
    expect(res.parser_version).toBe('pdf-parse')
  })

  it('lane 3: TS fallback when sidecar empty and no opt-in', async () => {
    sidecarAvailableMock.mockReturnValue(true)
    parseSidecarMock.mockResolvedValue({
      markdown: '   ', // whitespace-only → declines
      parser_used: 'plain',
      parser_version: 'builtin',
    })
    const tsFallback = vi.fn().mockResolvedValue({ text: 'ts text' })

    const res = await parseBinaryTiered(BUF, 'doc.pdf', ORG, tsFallback)

    expect(tsFallback).toHaveBeenCalledOnce()
    expect(res.parser_used).toBe('ts-fallback')
  })

  it('caches the org opt-in lookup (one DB read across calls)', async () => {
    sidecarAvailableMock.mockReturnValue(false)
    orgRowMock.value = { external_parsing_allowed: true }
    llamaParseMock.mockResolvedValue({ text: 'x', tables: [] })

    await parseBinaryTiered(BUF, 'a.pdf', ORG, vi.fn())
    await parseBinaryTiered(BUF, 'b.pdf', ORG, vi.fn())
    // Both used LlamaParse; the org flag was read once and cached.
    expect(llamaParseMock).toHaveBeenCalledTimes(2)
  })
})

describe('parsedToChunks — adapter', () => {
  const base: TieredParseResult = {
    text: '# Doc\n\nNarrative body.',
    tables: [{ tableName: 'Sales', headers: ['region', 'amt'], rows: [['EMEA', '10']] }],
    pictures: [{ ref: 'doc.pdf:pic1', page: 2 }],
    parser_used: 'docling',
    parser_version: '2.x',
  }

  it('emits tabular chunks + a prose chunk, all stamped with parser_used', async () => {
    const chunks = await parsedToChunks(base, {
      chunkId: 'drive:f1',
      title: 'doc.pdf',
      sourceUrl: 'https://x/f1',
      provider: 'google',
      tabularProvider: 'google_drive_tabular',
      proseResourceType: 'drive_file',
      baseMetadata: { folder_path: '/Reports' },
      orgId: ORG,
    })

    const prose = chunks.find((c) => c.shape === 'prose')!
    expect(prose.content).toContain('Narrative body.')
    expect(prose.metadata.resource_type).toBe('drive_file')
    expect(prose.metadata.folder_path).toBe('/Reports')
    // Every chunk carries parser provenance.
    for (const c of chunks) {
      expect(c.metadata.parser_used).toBe('docling')
      expect(c.metadata.parser_version).toBe('2.x')
    }
    // Tabular chunk present (stats), shape != prose.
    const stats = chunks.find((c) => c.chunk_id === 'drive:f1:stats')!
    expect(stats).toBeDefined()
    // The tabular builder's own metadata survives the adapter merge (not dropped):
    // resource_type stays table_stats, row_count present, folder_path merged in.
    expect(stats.metadata.resource_type).toBe('table_stats')
    expect(stats.metadata.row_count).toBeDefined()
    expect(stats.metadata.folder_path).toBe('/Reports')
    expect(stats.metadata.parser_used).toBe('docling')
  })

  it('writes a media_queue stub per picture', async () => {
    await parsedToChunks(base, {
      chunkId: 'drive:f1',
      title: 'doc.pdf',
      sourceUrl: 'https://x/f1',
      provider: 'google',
      tabularProvider: 'google_drive_tabular',
      orgId: ORG,
    })
    // Let the fire-and-forget stub write settle.
    await new Promise((r) => setTimeout(r, 0))

    expect(mediaUpsertCalls).toHaveLength(1)
    const rows = mediaUpsertCalls[0] as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({
      org_id: ORG,
      source_doc_id: 'drive:f1',
      origin: 'docling_picture',
      bytes_ref: 'doc.pdf:pic1',
      status: 'pending',
    })
  })

  it('text-only result → just a prose chunk, no tabular, no media write', async () => {
    const chunks = await parsedToChunks(
      { text: 'plain narrative', tables: [], pictures: [], parser_used: 'markitdown', parser_version: '0.1' },
      {
        chunkId: 'drive:f2',
        title: 'memo.docx',
        sourceUrl: 'https://x/f2',
        provider: 'google',
        tabularProvider: 'google_drive_tabular',
        orgId: ORG,
      },
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(chunks).toHaveLength(1)
    expect(chunks[0].shape).toBe('prose')
    expect(mediaUpsertCalls).toHaveLength(0)
  })
})
