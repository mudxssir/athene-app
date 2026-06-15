// ============================================================
// lib/indexing/__tests__/re-encrypt.test.ts — P7-1
//
// Paged re-encryption: plaintext rows become encrypted + preview-redacted,
// already-encrypted rows are skipped, and paging cursors are correct.
// ============================================================

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

const { dbResponses, updates } = vi.hoisted(() => ({
  dbResponses: [] as Array<{ data?: unknown; error?: unknown }>,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/supabase/server', () => {
  const next = () => dbResponses.shift() ?? { data: [], error: null }
  const make = () => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gt', 'order', 'limit']) b[m] = vi.fn(() => b)
    b.update = vi.fn((p: Record<string, unknown>) => { updates.push(p); return b })
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(next()).then(res, rej)
    return b
  }
  return { supabaseAdmin: { from: vi.fn(() => make()) } }
})

beforeAll(() => { process.env.KMS_KEY = 'test-master-key-reencrypt' })

import { reEncryptChunkTextPage } from '@/lib/indexing/re-encrypt'
import { isEncrypted } from '@/lib/indexing/chunk-crypto'

const ORG = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

beforeEach(() => {
  vi.clearAllMocks()
  dbResponses.length = 0
  updates.length = 0
})

describe('reEncryptChunkTextPage (P7-1)', () => {
  it('encrypts plaintext rows + redacts preview, skips encrypted/empty', async () => {
    dbResponses.push({
      data: [
        { id: 'r1', metadata: { chunk_text: 'plaintext one', provider: 'jira' } },
        { id: 'r2', metadata: { chunk_text: 'encv1:already', provider: 'slack' } }, // already encrypted
        { id: 'r3', metadata: { chunk_text: '' } },                                  // nothing to do
      ],
      error: null,
    })
    dbResponses.push({ error: null }) // the single update (r1)

    const res = await reEncryptChunkTextPage(ORG, '', 200)
    expect(res.processed).toBe(3)
    expect(res.encrypted).toBe(1)
    expect(res.nextCursor).toBeNull() // 3 < limit 200

    // r1 rewritten: chunk_text now an envelope, preview redacted, other keys kept.
    expect(updates).toHaveLength(1)
    const meta = (updates[0].metadata as { chunk_text: string; provider: string })
    expect(isEncrypted(meta.chunk_text)).toBe(true)
    expect(meta.provider).toBe('jira')
    expect(updates[0].content_preview).toBe('')
  })

  it('returns the last id as nextCursor on a full page', async () => {
    dbResponses.push({ data: [{ id: 'a', metadata: { chunk_text: 'encv1:x' } }, { id: 'b', metadata: { chunk_text: 'encv1:y' } }], error: null })
    const res = await reEncryptChunkTextPage(ORG, '', 2)
    expect(res.nextCursor).toBe('b')
    expect(res.encrypted).toBe(0) // both already encrypted
  })

  it('no-ops on an empty page', async () => {
    dbResponses.push({ data: [], error: null })
    expect(await reEncryptChunkTextPage(ORG, '')).toEqual({ processed: 0, encrypted: 0, nextCursor: null })
  })
})
