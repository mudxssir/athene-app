// ============================================================
// lib/integrations/__tests__/email-clean.test.ts
//
// P3-6: buildEmailChunks — embed the reply, keep the quoted tail/signature as a
// non-embedded provenance chunk, fail open to the full body when the sidecar
// declines. cleanEmail (the sidecar client) is mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { cleanEmailMock } = vi.hoisted(() => ({ cleanEmailMock: vi.fn() }))

vi.mock('@/lib/integrations/sidecar-client', () => ({ cleanEmail: cleanEmailMock }))
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { buildEmailChunks } from '@/lib/integrations/email-clean'
import type { FetchedChunk } from '@/lib/integrations/base'

const template: Omit<FetchedChunk, 'content'> = {
  chunk_id: 'gmail:m-1',
  title: 'Re: Plan',
  source_url: 'https://mail/m-1',
  shape: 'email',
  metadata: { provider: 'google', resource_type: 'email' },
}
const HEADER = 'From: bob@x.com\nSubject: Re: Plan\n\n'
const BODY = 'Sounds good!\n\nOn Mon, Alice wrote:\n> the long quoted thread'

beforeEach(() => vi.clearAllMocks())

describe('buildEmailChunks (P3-6)', () => {
  it('fail-open: no sidecar → single chunk with full body, no provenance', async () => {
    cleanEmailMock.mockResolvedValue(null)

    const chunks = await buildEmailChunks(template, HEADER, BODY, 'bob@x.com')

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(HEADER + BODY)
    expect(chunks[0].skip_embedding).toBeUndefined()
  })

  it('embeds the reply + emits a non-embedded provenance chunk for the quoted tail', async () => {
    cleanEmailMock.mockResolvedValue({
      reply_text: 'Sounds good!',
      signature: '-- Bob, Acme Corp',
      quoted_tail: 'On Mon, Alice wrote:\n> the long quoted thread',
      stripped_ratio: 0.7,
    })

    const chunks = await buildEmailChunks(template, HEADER, BODY, 'bob@x.com')

    expect(chunks).toHaveLength(2)
    // Primary: header + reply only (quoted chain NOT embedded)
    const main = chunks[0]
    expect(main.content).toBe(HEADER + 'Sounds good!')
    expect(main.skip_embedding).toBeUndefined()
    expect(main.chunk_id).toBe('gmail:m-1')
    // Provenance: skip_embedding, carries tail + signature, distinct chunk_id
    const prov = chunks[1]
    expect(prov.skip_embedding).toBe(true)
    expect(prov.chunk_id).toBe('gmail:m-1#quoted')
    expect(prov.content).toContain('the long quoted thread')
    expect(prov.content).toContain('-- Bob, Acme Corp')
    expect(prov.metadata.resource_type).toBe('email_quoted_tail')
  })

  it('cleaned but no tail/signature → single reply chunk, no provenance', async () => {
    cleanEmailMock.mockResolvedValue({
      reply_text: 'Just a fresh email, no quotes.',
      signature: '',
      quoted_tail: '',
      stripped_ratio: 0,
    })

    const chunks = await buildEmailChunks(template, HEADER, 'Just a fresh email, no quotes.')

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(HEADER + 'Just a fresh email, no quotes.')
  })

  it('empty reply_text (Talon found nothing) → fail open to full body', async () => {
    cleanEmailMock.mockResolvedValue({
      reply_text: '   ',
      signature: '',
      quoted_tail: '',
      stripped_ratio: 1,
    })

    const chunks = await buildEmailChunks(template, HEADER, BODY)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe(HEADER + BODY)
  })
})
