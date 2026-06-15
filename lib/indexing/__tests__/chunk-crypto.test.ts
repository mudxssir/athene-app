// ============================================================
// lib/indexing/__tests__/chunk-crypto.test.ts — P7-1
//
// Per-org AES-GCM round-trip, envelope detection, tamper/wrong-key rejection,
// and plaintext passthrough.
// ============================================================

import { describe, it, expect, beforeAll, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

beforeAll(() => { process.env.KMS_KEY = 'test-master-key-for-chunk-crypto' })

import { encryptChunkText, decryptChunkText, isEncrypted } from '@/lib/indexing/chunk-crypto'

const ORG = '11111111-1111-1111-1111-111111111111'
const ORG2 = '22222222-2222-2222-2222-222222222222'

describe('chunk-crypto (P7-1)', () => {
  it('round-trips plaintext for the same org', () => {
    const text = 'Confidential: the Q3 migration plan and customer list.'
    const env = encryptChunkText(text, ORG)
    expect(isEncrypted(env)).toBe(true)
    expect(env).not.toContain('Confidential')         // ciphertext, not plaintext
    expect(decryptChunkText(env, ORG)).toBe(text)
  })

  it('produces a different envelope each time (random IV) but both decrypt', () => {
    const a = encryptChunkText('same text', ORG)
    const b = encryptChunkText('same text', ORG)
    expect(a).not.toBe(b)
    expect(decryptChunkText(a, ORG)).toBe('same text')
    expect(decryptChunkText(b, ORG)).toBe('same text')
  })

  it('cannot decrypt with another org key (per-org isolation)', () => {
    const env = encryptChunkText('org-1 secret', ORG)
    expect(decryptChunkText(env, ORG2)).toBeNull()
  })

  it('rejects a tampered envelope (GCM auth) → null', () => {
    const env = encryptChunkText('integrity matters', ORG)
    const tampered = env.slice(0, -4) + (env.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect(decryptChunkText(tampered, ORG)).toBeNull()
  })

  it('passes plaintext through unchanged (mixed-row migration safety)', () => {
    expect(isEncrypted('just plain text')).toBe(false)
    expect(decryptChunkText('just plain text', ORG)).toBe('just plain text')
  })

  it('handles empty org id defensively', () => {
    expect(encryptChunkText('x', '')).toBe('x')           // no key → plaintext
    expect(decryptChunkText(encryptChunkText('x', ORG), '')).toBeNull()
  })
})
