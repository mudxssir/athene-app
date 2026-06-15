// ============================================================
// lib/indexing/__tests__/chunk-text-store-crypto.test.ts — P7-1
//
// chunk-text-store under CHUNK_TEXT_ENCRYPTION: writeChunkText encrypts (with
// orgId), readChunkText decrypts via row.org_id, content_preview is redacted, and
// a wrong/missing org_id fails closed.
// ============================================================

import { describe, it, expect, beforeAll, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/config/feature-flags', () => ({ CHUNK_TEXT_ENCRYPTION: true }))

beforeAll(() => { process.env.KMS_KEY = 'test-master-key-store' })

import { writeChunkText, readChunkText, chunkPreview, hasFullChunkText } from '@/lib/indexing/chunk-text-store'
import { isEncrypted } from '@/lib/indexing/chunk-crypto'

const ORG = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

describe('chunk-text-store encryption (P7-1)', () => {
  it('writeChunkText encrypts when an orgId is supplied', () => {
    const meta = writeChunkText({ provider: 'google' }, 'secret body', ORG)
    expect(isEncrypted(meta.chunk_text as string)).toBe(true)
    expect(meta.provider).toBe('google')
    expect(hasFullChunkText({ metadata: meta })).toBe(true) // envelope = full text present
  })

  it('readChunkText decrypts using the row org_id', () => {
    const meta = writeChunkText({}, 'round trip', ORG)
    expect(readChunkText({ metadata: meta, org_id: ORG })).toBe('round trip')
  })

  it('falls back to org_id from metadata when the column is absent', () => {
    const meta = writeChunkText({ org_id: ORG }, 'via meta', ORG)
    expect(readChunkText({ metadata: meta })).toBe('via meta')
  })

  it('fails closed (null) when the org_id is wrong/missing', () => {
    const meta = writeChunkText({}, 'no key', ORG)
    expect(readChunkText({ metadata: meta, org_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' })).toBeNull()
    expect(readChunkText({ metadata: meta })).toBeNull() // no org_id anywhere → cannot decrypt, preview empty
  })

  it('redacts content_preview under encryption', () => {
    expect(chunkPreview('this would otherwise leak at rest')).toBe('')
  })

  it('still writes plaintext when no orgId is passed (back-compat)', () => {
    const meta = writeChunkText({}, 'plain', undefined)
    expect(meta.chunk_text).toBe('plain')
    expect(readChunkText({ metadata: meta })).toBe('plain')
  })
})
