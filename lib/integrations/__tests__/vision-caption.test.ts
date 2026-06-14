// ============================================================
// lib/integrations/__tests__/vision-caption.test.ts — P5-2
//
// Caption prompt selection, sanitize/clamp, the vision call (mocked LLM:
// success / empty-retry / throw-retry), and the prose caption chunk
// (success + terminal-failure placeholder).
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

// Mock the LLM factory — captionImage resolves a model and calls .invoke().
const invokeMock = vi.fn()
vi.mock('@/lib/langgraph/llm-factory', () => ({
  resolveModelClient: vi.fn(async () => ({ invoke: invokeMock })),
}))

import {
  captionImage,
  sanitizeCaption,
  captionKindForOrigin,
  mimeForFormat,
  buildCaptionChunk,
  CAPTION_UNAVAILABLE,
} from '@/lib/integrations/vision-caption'

beforeEach(() => {
  invokeMock.mockReset()
})

describe('captionKindForOrigin (P5-2)', () => {
  it('routes BI origins to chart, figures to diagram, else photo', () => {
    expect(captionKindForOrigin('powerbi_chart')).toBe('chart')
    expect(captionKindForOrigin('bi_artifact_png')).toBe('chart')
    expect(captionKindForOrigin('docling_picture')).toBe('diagram')
    expect(captionKindForOrigin('notion_image')).toBe('diagram')
    expect(captionKindForOrigin('gmail_attachment')).toBe('photo')
    expect(captionKindForOrigin('slack_file')).toBe('photo')
  })
})

describe('mimeForFormat (P5-2)', () => {
  it('maps known formats and defaults the unknown', () => {
    expect(mimeForFormat('jpeg')).toBe('image/jpeg')
    expect(mimeForFormat('png')).toBe('image/png')
    expect(mimeForFormat('webp')).toBe('image/webp')
    expect(mimeForFormat('unknown')).toBe('application/octet-stream')
  })
})

describe('sanitizeCaption (P5-2)', () => {
  it('collapses whitespace, strips URLs and wrapping quotes, clamps length', () => {
    expect(sanitizeCaption('  A   bar\nchart  ')).toBe('A bar chart')
    expect(sanitizeCaption('See http://evil.test/x for more')).toBe('See for more')
    expect(sanitizeCaption('"a quoted caption"')).toBe('a quoted caption')
    expect(sanitizeCaption('x'.repeat(1000)).length).toBe(600)
  })
})

describe('captionImage (P5-2)', () => {
  const buf = Buffer.from('fake-image-bytes')

  it('returns a sanitized caption on success and sends a base64 data URL', async () => {
    invokeMock.mockResolvedValueOnce({ content: '  A line chart of revenue by quarter.  ' })
    const caption = await captionImage(buf, 'image/png', 'chart', 'org-1')
    expect(caption).toBe('A line chart of revenue by quarter.')

    // The image was sent as an image_url data URL with the right mime + base64.
    const msg = invokeMock.mock.calls[0][0][0]
    const parts = msg.content as Array<{ type: string; image_url?: { url: string } }>
    const img = parts.find((p) => p.type === 'image_url')
    expect(img?.image_url?.url).toBe(`data:image/png;base64,${buf.toString('base64')}`)
  })

  it('retries on an empty caption then returns null', async () => {
    invokeMock.mockResolvedValueOnce({ content: '   ' }).mockResolvedValueOnce({ content: '' })
    const caption = await captionImage(buf, 'image/png', 'photo', 'org-1', 2)
    expect(caption).toBeNull()
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('retries on a thrown error then returns null', async () => {
    invokeMock.mockRejectedValueOnce(new Error('vision 500')).mockRejectedValueOnce(new Error('vision 500'))
    const caption = await captionImage(buf, 'image/jpeg', 'photo', 'org-1', 2)
    expect(caption).toBeNull()
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('succeeds on a later attempt after an early failure', async () => {
    invokeMock.mockRejectedValueOnce(new Error('rate limit')).mockResolvedValueOnce({ content: 'A diagram.' })
    expect(await captionImage(buf, 'image/png', 'diagram', 'org-1', 2)).toBe('A diagram.')
  })

  it('handles content-block array responses', async () => {
    invokeMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'A bar chart' }, { type: 'text', text: ' of sales.' }],
    })
    expect(await captionImage(buf, 'image/png', 'chart', 'org-1')).toBe('A bar chart of sales.')
  })

  it('returns null for an empty buffer without calling the model', async () => {
    expect(await captionImage(Buffer.alloc(0), 'image/png', 'photo')).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('buildCaptionChunk (P5-2)', () => {
  const base = {
    chunkId: 'media:gmail:msg1:abc12345',
    breadcrumb: 'Drive › Q3 › report.pdf',
    sourceUrl: 'https://drive.example/report.pdf',
    provider: 'google',
    sourceDocId: 'gmail:msg1',
    origin: 'docling_picture',
    sha256: 'a'.repeat(64),
  }

  it('wraps a caption in the [Image in {breadcrumb}] provenance prefix', () => {
    const chunk = buildCaptionChunk({ ...base, caption: 'A flow diagram of the pipeline.' })
    expect(chunk.shape).toBe('prose')
    expect(chunk.content).toBe('[Image in Drive › Q3 › report.pdf]: A flow diagram of the pipeline.')
    expect(chunk.metadata.resource_type).toBe('media_caption')
    expect(chunk.metadata.media_origin).toBe('docling_picture')
    expect(chunk.metadata.parent_doc_id).toBe('gmail:msg1')
    expect(chunk.metadata.caption_status).toBe('captioned')
    expect(chunk.metadata.media_sha256).toBe('a'.repeat(64))
    expect(chunk.source_url).toBe(base.sourceUrl)
  })

  it('emits the placeholder (caption unavailable) when caption is null', () => {
    const chunk = buildCaptionChunk({ ...base, caption: null })
    expect(chunk.content).toBe(`[Image in Drive › Q3 › report.pdf]: ${CAPTION_UNAVAILABLE}`)
    expect(chunk.metadata.caption_status).toBe('unavailable')
  })

  it('falls back to a bare [Image] prefix when there is no breadcrumb', () => {
    const chunk = buildCaptionChunk({ ...base, breadcrumb: '', caption: 'A photo.' })
    expect(chunk.content).toBe('[Image]: A photo.')
  })

  it('omits media_sha256 when not provided', () => {
    const { sha256: _omit, ...noSha } = base
    const chunk = buildCaptionChunk({ ...noSha, caption: 'x' })
    expect(chunk.metadata.media_sha256).toBeUndefined()
  })
})
