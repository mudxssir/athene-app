// ============================================================
// lib/integrations/__tests__/caption-worker.test.ts — P5-5
//
// The per-org drain orchestration: happy caption, org-wide dedup, decorative
// skip, un-fetchable provenance skip, transient retry / exhaustion → placeholder,
// caption-model failure → placeholder, parent-missing retry, and the daily
// budget (defer overflow). All P5 lib deps + indexDocument are mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/config/feature-flags', () => ({ MEDIA_CAPTIONS: true }))
vi.mock('@/lib/qstash/client', () => ({ qstash: { publishJSON: vi.fn(() => Promise.resolve({ messageId: 'm' })) } }))
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: { from: vi.fn(() => ({ upsert: vi.fn(() => Promise.resolve({ error: null })) })) },
}))

const { mq, mb, mp, vc, indexDocument } = vi.hoisted(() => ({
  mq: {
    claimPendingBatch: vi.fn(),
    reclaimStaleProcessing: vi.fn(() => Promise.resolve(0)),
    findCaptionBySha: vi.fn(),
    captionsUsedToday: vi.fn(),
    markDone: vi.fn(() => Promise.resolve()),
    markDeferred: vi.fn(() => Promise.resolve()),
    markSkipped: vi.fn(() => Promise.resolve()),
    markFailed: vi.fn(() => Promise.resolve()),
    bumpAttemptAndRequeue: vi.fn(),
    DAILY_CAPTION_CAP: 500,
  },
  mb: { resolveParentContext: vi.fn(), resolveMediaBytes: vi.fn() },
  mp: { sha256: vi.fn(() => 'deadbeef'), classifyMedia: vi.fn(), stripExif: vi.fn((b: Buffer) => b) },
  vc: {
    captionImage: vi.fn(),
    buildCaptionChunk: vi.fn((a: { caption: string | null }) => ({ chunk: true, caption: a.caption })),
    captionKindForOrigin: vi.fn(() => 'photo'),
    mimeForFormat: vi.fn(() => 'image/png'),
  },
  indexDocument: vi.fn(() => Promise.resolve('doc-id')),
}))

vi.mock('@/lib/integrations/media-queue', () => mq)
vi.mock('@/lib/integrations/media-bytes', () => mb)
vi.mock('@/lib/integrations/media-prep', () => mp)
vi.mock('@/lib/integrations/vision-caption', () => vc)
vi.mock('@/lib/integrations/indexing', () => ({ indexDocument }))

import { runCaptionDrain } from '@/lib/integrations/caption-worker'

const ORG = 'org-1'
const ctx = {
  documentId: 'doc-1', connectionId: 'conn-1', departmentId: 'dept-1', ownerUserId: 'user-1',
  visibility: 'restricted', provider: 'google', title: 'report.pdf',
  sourceUrl: 'https://x/report.pdf', breadcrumb: 'Drive › report.pdf',
}
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', org_id: ORG, source_doc_id: 'gmail:msg1', sha256: null,
  origin: 'gmail_attachment', bytes_ref: 'att1', caption: null, status: 'processing', attempts: 0, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  // Happy-path defaults.
  mq.captionsUsedToday.mockResolvedValue(0)
  mq.claimPendingBatch.mockResolvedValue([row()])
  mq.findCaptionBySha.mockResolvedValue(null)
  mq.bumpAttemptAndRequeue.mockResolvedValue(true)
  mb.resolveParentContext.mockResolvedValue(ctx)
  mb.resolveMediaBytes.mockResolvedValue({ ok: true, bytes: Buffer.from('img') })
  mp.classifyMedia.mockReturnValue({ action: 'caption', format: 'png' })
  vc.captionImage.mockResolvedValue('A bar chart of revenue.')
})

describe('runCaptionDrain — happy path (P5-5)', () => {
  it('captions an image and indexes the chunk inheriting parent visibility', async () => {
    const s = await runCaptionDrain(ORG)
    expect(s).toMatchObject({ claimed: 1, captioned: 1, skipped: 0, failed: 0, deferred: 0 })
    // EXIF stripped before the model call.
    expect(mp.stripExif).toHaveBeenCalled()
    // Indexed with the parent's connection/dept/visibility/owner (no widening).
    expect(indexDocument).toHaveBeenCalledWith(
      expect.objectContaining({ caption: 'A bar chart of revenue.' }),
      ORG, 'conn-1', 'dept-1', 'restricted', 'user-1',
    )
    expect(mq.markDone).toHaveBeenCalledWith('r1', ORG, 'deadbeef', 'A bar chart of revenue.')
  })

  it('reuses a prior caption on a SHA hit (no model call)', async () => {
    mq.findCaptionBySha.mockResolvedValue('A reused company logo.')
    const s = await runCaptionDrain(ORG)
    expect(s).toMatchObject({ deduped: 1, captioned: 0 })
    expect(vc.captionImage).not.toHaveBeenCalled()
    expect(mq.markDone).toHaveBeenCalledWith('r1', ORG, 'deadbeef', 'A reused company logo.')
  })
})

describe('runCaptionDrain — skips (P5-5, D12 never silently drop)', () => {
  it('skips a decorative image without indexing', async () => {
    mp.classifyMedia.mockReturnValue({ action: 'skip', reason: 'decorative' })
    const s = await runCaptionDrain(ORG)
    expect(s).toMatchObject({ skipped: 1, captioned: 0 })
    expect(mq.markSkipped).toHaveBeenCalledWith('r1', ORG, 'decorative')
    expect(indexDocument).not.toHaveBeenCalled()
  })

  it('skips an un-fetchable provenance ref (docling_picture P3→P5 gap)', async () => {
    mb.resolveMediaBytes.mockResolvedValue({ ok: false, reason: 'provenance_ref_unfetchable', transient: false })
    const s = await runCaptionDrain(ORG)
    expect(s).toMatchObject({ skipped: 1 })
    expect(mq.markSkipped).toHaveBeenCalledWith('r1', ORG, 'provenance_ref_unfetchable')
  })
})

describe('runCaptionDrain — retries + placeholders (P5-5)', () => {
  it('re-queues a transient fetch error', async () => {
    mb.resolveMediaBytes.mockResolvedValue({ ok: false, reason: 'fetch_error', transient: true })
    mq.bumpAttemptAndRequeue.mockResolvedValue(true)
    const s = await runCaptionDrain(ORG)
    expect(s).toMatchObject({ requeued: 1, failed: 0 })
    expect(mq.markFailed).not.toHaveBeenCalled()
  })

  it('emits a placeholder + fails after exhausting transient retries', async () => {
    mb.resolveMediaBytes.mockResolvedValue({ ok: false, reason: 'fetch_error', transient: true })
    mq.bumpAttemptAndRequeue.mockResolvedValue(false)
    const s = await runCaptionDrain(ORG)
    expect(s).toMatchObject({ failed: 1 })
    expect(indexDocument).toHaveBeenCalledWith(
      expect.objectContaining({ caption: null }), ORG, 'conn-1', 'dept-1', 'restricted', 'user-1',
    )
    expect(mq.markFailed).toHaveBeenCalledWith('r1', ORG, 'fetch_error')
  })

  it('emits a placeholder when the vision model fails to caption', async () => {
    vc.captionImage.mockResolvedValue(null)
    const s = await runCaptionDrain(ORG)
    expect(s).toMatchObject({ failed: 1, captioned: 0 })
    expect(indexDocument).toHaveBeenCalledWith(
      expect.objectContaining({ caption: null }), ORG, 'conn-1', 'dept-1', 'restricted', 'user-1',
    )
    expect(mq.markFailed).toHaveBeenCalledWith('r1', ORG, 'caption_failed')
  })

  it('re-queues then terminally skips a missing parent', async () => {
    mb.resolveParentContext.mockResolvedValue(null)
    mq.bumpAttemptAndRequeue.mockResolvedValueOnce(true)
    expect((await runCaptionDrain(ORG)).requeued).toBe(1)

    mb.resolveParentContext.mockResolvedValue(null)
    mq.bumpAttemptAndRequeue.mockResolvedValueOnce(false)
    const s2 = await runCaptionDrain(ORG)
    expect(s2.skipped).toBe(1)
    expect(mq.markSkipped).toHaveBeenCalledWith('r1', ORG, 'parent_missing')
  })
})

describe('runCaptionDrain — budget (P5-5)', () => {
  it('defers overflow rows once the daily cap is hit (never dropped)', async () => {
    mq.captionsUsedToday.mockResolvedValue(499) // remaining = 1
    mq.claimPendingBatch.mockResolvedValue([row({ id: 'r1' }), row({ id: 'r2' })])
    const s = await runCaptionDrain(ORG)
    expect(s).toMatchObject({ captioned: 1, deferred: 1 })
    expect(mq.markDeferred).toHaveBeenCalledWith('r2', ORG)
  })

  it('does not even claim when the budget is exhausted up front', async () => {
    mq.captionsUsedToday.mockResolvedValue(500)
    const s = await runCaptionDrain(ORG)
    expect(s.claimed).toBe(0)
    expect(mq.claimPendingBatch).not.toHaveBeenCalled()
  })
})
