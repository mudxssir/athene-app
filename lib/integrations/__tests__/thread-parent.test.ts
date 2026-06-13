// ============================================================
// lib/integrations/__tests__/thread-parent.test.ts
//
// P3-8: buildThreadParentChunks groups email message chunks by thread_id and
// emits one synthetic, non-embedded thread-parent chunk per multi-message thread.
// ============================================================

import { describe, it, expect } from 'vitest'
import { buildThreadParentChunks } from '@/lib/integrations/thread-parent'
import type { FetchedChunk } from '@/lib/integrations/base'

function msg(id: string, threadId: string, subject: string, from: string, date: string): FetchedChunk {
  return {
    chunk_id: `gmail:${id}`,
    title: subject,
    content: 'body',
    source_url: `https://mail/${id}`,
    shape: 'email',
    metadata: { provider: 'google', resource_type: 'email', thread_id: threadId, author: from, last_modified: date },
  }
}

const opts = {
  idPrefix: 'gmail',
  provider: 'google',
  sourceUrlFor: (m: FetchedChunk) => m.source_url,
}

describe('buildThreadParentChunks (P3-8)', () => {
  it('emits one non-embedded parent per thread with ≥2 messages', () => {
    const chunks = [
      msg('a', 't-1', 'Re: Launch', 'bob@x.com', '2026-06-01T10:00:00Z'),
      msg('b', 't-1', 'Re: Launch', 'alice@x.com', '2026-06-02T09:00:00Z'),
    ]

    const parents = buildThreadParentChunks(chunks, opts)

    expect(parents).toHaveLength(1)
    const p = parents[0]
    expect(p.chunk_id).toBe('gmail:thread:t-1')
    expect(p.skip_embedding).toBe(true)
    expect(p.metadata.resource_type).toBe('email_thread')
    expect(p.metadata.message_count).toBe(2)
    // Digest: subject stripped of Re:, both participants, chronological lines.
    expect(p.content).toContain('Thread: Launch')
    expect(p.content).toContain('Participants: bob@x.com, alice@x.com')
    expect(p.content).toContain('Messages: 2')
    expect(p.content).toContain('2026-06-01 bob@x.com')
  })

  it('skips single-message threads (the message is its own context)', () => {
    const parents = buildThreadParentChunks(
      [msg('solo', 't-2', 'Standalone', 'bob@x.com', '2026-06-01T10:00:00Z')],
      opts,
    )
    expect(parents).toHaveLength(0)
  })

  it('ignores provenance (#quoted), calendar records, and missing thread_id', () => {
    const provenance: FetchedChunk = {
      ...msg('a', 't-3', 'Re: X', 'bob@x.com', '2026-06-01T10:00:00Z'),
      chunk_id: 'gmail:a#quoted',
      skip_embedding: true,
    }
    const calendar: FetchedChunk = {
      ...msg('c', 't-3', 'Invite', 'bob@x.com', '2026-06-01T10:00:00Z'),
      shape: 'record',
    }
    const noThread: FetchedChunk = {
      ...msg('d', '', 'No thread', 'bob@x.com', '2026-06-01T10:00:00Z'),
      metadata: { provider: 'google', resource_type: 'email', author: 'bob@x.com' },
    }
    // Only one real email message in t-3 → no parent (needs ≥2).
    const parents = buildThreadParentChunks(
      [provenance, calendar, noThread, msg('a', 't-3', 'Re: X', 'bob@x.com', '2026-06-01T10:00:00Z')],
      opts,
    )
    expect(parents).toHaveLength(0)
  })

  it('windows huge threads: lists 50, summarizes the rest', () => {
    const chunks = Array.from({ length: 55 }, (_, i) =>
      msg(`m${i}`, 't-big', 'Re: Big', `u${i}@x.com`, `2026-06-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`),
    )
    const [p] = buildThreadParentChunks(chunks, opts)
    expect(p.metadata.message_count).toBe(55)
    expect(p.content).toContain('… and 5 earlier messages')
  })
})
