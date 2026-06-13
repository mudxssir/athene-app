// ============================================================
// lib/integrations/thread-parent.ts — P3-8
//
// Synthetic thread-parent chunks for email. P3-5 makes each email its own
// document; the *parent-return unit* for small-to-big retrieval is the THREAD
// (all messages sharing a thread_id). Because that parent spans multiple
// documents, it cannot use the within-document parent_chunk_index JOIN (P1-8) —
// instead we materialize one synthetic, non-embedded "thread parent" document
// per thread_id holding a deterministic digest (subject, participants, per-
// message one-liners). It is re-emitted every sync, so it refreshes whenever a
// new message in the thread is indexed (content-hash dedup skips unchanged
// digests).
//
// skip_embedding (P3-6): the parent is a return/context unit, retrieved via
// thread linkage — never vector-searched — so it carries no embedding.
//
// NOTE: the retrieval-time child→thread-parent JOIN is a search-layer change
// tracked as a P3 follow-up; this builds the anchor the JOIN (and P3-10's thread
// context line) attach to.
// ============================================================

import 'server-only'
import type { FetchedChunk } from './base'

/** Messages beyond this are summarized as a count, not listed (huge-thread window). */
const MAX_THREAD_LINES = 50

interface ThreadParentOpts {
  /** `gmail` | `ms_email` — used for the synthetic chunk_id prefix. */
  idPrefix: string
  /** provider string for the synthetic chunk's metadata. */
  provider: string
  /** Build the thread's source_url from its first message chunk. */
  sourceUrlFor: (firstMessage: FetchedChunk) => string
}

/**
 * Group the given email message chunks by thread_id and return one synthetic
 * thread-parent chunk per thread that has ≥2 messages. Single-message threads
 * need no parent (the message is its own context). Input chunks that are not
 * embeddable email messages (provenance #quoted, calendar records) are ignored.
 */
export function buildThreadParentChunks(
  messageChunks: FetchedChunk[],
  opts: ThreadParentOpts,
): FetchedChunk[] {
  // Only real email message chunks anchor a thread.
  const messages = messageChunks.filter(
    (c) => c.shape === 'email' && !c.skip_embedding && !c.chunk_id.endsWith('#quoted'),
  )

  const byThread = new Map<string, FetchedChunk[]>()
  for (const m of messages) {
    const threadId = m.metadata.thread_id
    if (typeof threadId !== 'string' || !threadId) continue
    const arr = byThread.get(threadId)
    if (arr) arr.push(m)
    else byThread.set(threadId, [m])
  }

  const parents: FetchedChunk[] = []
  for (const [threadId, msgs] of byThread) {
    if (msgs.length < 2) continue

    // Deterministic, chronological digest.
    const sorted = [...msgs].sort((a, b) => {
      const da = String(a.metadata.last_modified ?? '')
      const db = String(b.metadata.last_modified ?? '')
      return da.localeCompare(db)
    })
    const subject = sorted[0].title.replace(/^(Re|Fwd):\s*/i, '').trim()
    const participants = Array.from(
      new Set(sorted.map((m) => String(m.metadata.author ?? '')).filter(Boolean)),
    )

    const lines = [
      `Thread: ${subject || '(no subject)'}`,
      participants.length > 0 ? `Participants: ${participants.join(', ')}` : null,
      `Messages: ${sorted.length}`,
      '',
    ].filter((l) => l !== null) as string[]

    const shown = sorted.slice(0, MAX_THREAD_LINES)
    for (const m of shown) {
      const date = String(m.metadata.last_modified ?? '').slice(0, 10)
      const from = String(m.metadata.author ?? 'unknown')
      lines.push(`- ${date} ${from}: ${m.title}`)
    }
    if (sorted.length > MAX_THREAD_LINES) {
      lines.push(`- … and ${sorted.length - MAX_THREAD_LINES} earlier messages`)
    }

    parents.push({
      chunk_id: `${opts.idPrefix}:thread:${threadId}`,
      title: `Thread: ${subject || '(no subject)'}`,
      content: lines.join('\n'),
      source_url: opts.sourceUrlFor(sorted[0]),
      shape: 'email',
      skip_embedding: true,
      metadata: {
        provider: opts.provider,
        resource_type: 'email_thread',
        thread_id: threadId,
        message_count: sorted.length,
      },
    })
  }

  return parents
}
