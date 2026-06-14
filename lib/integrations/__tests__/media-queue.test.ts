// ============================================================
// lib/integrations/__tests__/media-queue.test.ts — P5-3
//
// Queue claim (race-safe flip), org-wide SHA dedup, daily budget, terminal
// transitions, and retry bump — against a thenable supabase fluent-builder mock
// driven by a FIFO of responses (one per terminal await/maybeSingle).
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { dbResponses, updateCalls, fromCalls } = vi.hoisted(() => ({
  dbResponses: [] as Array<{ data?: unknown; error?: unknown; count?: number }>,
  updateCalls: [] as unknown[],
  fromCalls: [] as string[],
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

vi.mock('@/lib/supabase/server', () => {
  const nextResponse = () => dbResponses.shift() ?? { data: null, error: null, count: 0 }
  const makeBuilder = () => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'not', 'gte', 'lt', 'insert', 'upsert']) {
      b[m] = vi.fn(() => b)
    }
    b.update = vi.fn((payload: unknown) => { updateCalls.push(payload); return b })
    b.maybeSingle = vi.fn(() => Promise.resolve(nextResponse()))
    // Thenable: awaiting any chain pulls the next FIFO response.
    b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(nextResponse()).then(resolve, reject)
    return b
  }
  return {
    supabaseAdmin: {
      from: vi.fn((table: string) => { fromCalls.push(table); return makeBuilder() }),
    },
  }
})

import {
  claimPendingBatch,
  reclaimStaleProcessing,
  findCaptionBySha,
  captionsUsedToday,
  hasBudgetRemaining,
  markDone,
  markDeferred,
  markSkipped,
  markFailed,
  bumpAttemptAndRequeue,
  queueDepth,
  DAILY_CAPTION_CAP,
  type MediaQueueRow,
} from '@/lib/integrations/media-queue'

const ORG = 'org-1'

beforeEach(() => {
  vi.clearAllMocks()
  dbResponses.length = 0
  updateCalls.length = 0
  fromCalls.length = 0
})

const row = (over: Partial<MediaQueueRow> = {}): MediaQueueRow => ({
  id: 'r1', org_id: ORG, source_doc_id: 'gmail:1', sha256: null,
  origin: 'gmail_attachment', bytes_ref: 'att1', caption: null,
  status: 'pending', attempts: 0, ...over,
})

describe('claimPendingBatch (P5-3)', () => {
  it('flips claimed candidates to processing and returns the rows', async () => {
    dbResponses.push({ data: [{ id: 'r1' }, { id: 'r2' }], error: null }) // candidate ids
    dbResponses.push({ data: [row({ id: 'r1', status: 'processing' }), row({ id: 'r2', status: 'processing' })], error: null })
    const claimed = await claimPendingBatch(ORG, 10)
    expect(claimed.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(updateCalls[0]).toMatchObject({ status: 'processing' })
  })

  it('returns [] when nothing is queued', async () => {
    dbResponses.push({ data: [], error: null })
    expect(await claimPendingBatch(ORG, 10)).toEqual([])
  })

  it('returns [] on a select error (non-fatal)', async () => {
    dbResponses.push({ data: null, error: { message: 'boom' } })
    expect(await claimPendingBatch(ORG, 10)).toEqual([])
  })
})

describe('reclaimStaleProcessing (P5-3)', () => {
  it('returns the count of reset rows', async () => {
    dbResponses.push({ data: [{ id: 'a' }, { id: 'b' }], error: null })
    expect(await reclaimStaleProcessing(ORG)).toBe(2)
    expect(updateCalls[0]).toMatchObject({ status: 'pending' })
  })
})

describe('findCaptionBySha (P5-3) — org-wide dedup', () => {
  it('returns a prior caption on a SHA hit', async () => {
    dbResponses.push({ data: { caption: 'A company logo.' }, error: null })
    expect(await findCaptionBySha(ORG, 'a'.repeat(64))).toBe('A company logo.')
  })

  it('returns null on miss and never queries for an empty sha', async () => {
    expect(await findCaptionBySha(ORG, '')).toBeNull()
    expect(fromCalls).toHaveLength(0)
    dbResponses.push({ data: null, error: null })
    expect(await findCaptionBySha(ORG, 'b'.repeat(64))).toBeNull()
  })
})

describe('budget (P5-3)', () => {
  it('counts today\'s captions and gates on the daily cap', async () => {
    dbResponses.push({ count: 42, error: null })
    expect(await captionsUsedToday(ORG)).toBe(42)

    dbResponses.push({ count: DAILY_CAPTION_CAP - 1, error: null })
    expect(await hasBudgetRemaining(ORG)).toBe(true)

    dbResponses.push({ count: DAILY_CAPTION_CAP, error: null })
    expect(await hasBudgetRemaining(ORG)).toBe(false)
  })

  it('assumes 0 used on a count error (fail-open to budget available)', async () => {
    dbResponses.push({ count: null, error: { message: 'x' } })
    expect(await captionsUsedToday(ORG)).toBe(0)
  })
})

describe('terminal transitions (P5-3)', () => {
  it('markDone stores caption + sha and status done', async () => {
    await markDone('r1', ORG, 'a'.repeat(64), 'A bar chart.')
    expect(updateCalls[0]).toMatchObject({ status: 'done', caption: 'A bar chart.', sha256: 'a'.repeat(64) })
  })
  it('markDeferred keeps it queued', async () => {
    await markDeferred('r1', ORG)
    expect(updateCalls[0]).toMatchObject({ status: 'deferred' })
  })
  it('markSkipped/markFailed record a clamped reason', async () => {
    await markSkipped('r1', ORG, 'decorative')
    expect(updateCalls[0]).toMatchObject({ status: 'skipped', skip_reason: 'decorative' })
    await markFailed('r1', ORG, 'x'.repeat(300))
    expect((updateCalls[1] as { skip_reason: string }).skip_reason.length).toBe(200)
    expect(updateCalls[1]).toMatchObject({ status: 'failed' })
  })
})

describe('bumpAttemptAndRequeue (P5-3)', () => {
  it('re-queues while under MAX_ATTEMPTS', async () => {
    const requeued = await bumpAttemptAndRequeue(row({ attempts: 1 }))
    expect(requeued).toBe(true)
    expect(updateCalls[0]).toMatchObject({ status: 'pending', attempts: 2 })
  })

  it('gives up at MAX_ATTEMPTS (no further requeue)', async () => {
    const requeued = await bumpAttemptAndRequeue(row({ attempts: 2 }))
    expect(requeued).toBe(false)
    expect(updateCalls[0]).toMatchObject({ attempts: 3 })
    expect(updateCalls[0]).not.toHaveProperty('status', 'pending')
  })
})

describe('queueDepth (P5-3)', () => {
  it('tallies rows by status for the admin surface', async () => {
    dbResponses.push({
      data: [
        { status: 'pending' }, { status: 'pending' }, { status: 'done' },
        { status: 'failed' }, { status: 'deferred' },
      ],
      error: null,
    })
    const depth = await queueDepth(ORG)
    expect(depth).toMatchObject({ pending: 2, done: 1, failed: 1, deferred: 1, processing: 0, skipped: 0 })
  })
})
