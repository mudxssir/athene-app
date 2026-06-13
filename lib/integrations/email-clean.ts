// ============================================================
// lib/integrations/email-clean.ts — P3-6
//
// Shared Talon email-cleaning helper for the Gmail and Outlook indexers. Strips
// the quoted chain + signature so a reply embeds only its own text, not the whole
// thread (the largest noise source in email corpora). Fails open: when the
// sidecar is unavailable or returns nothing useful, the full body is embedded
// unchanged — a noisier vector, never a lost message.
//
// The canonical header block (From/To/Cc/Subject/Date) is always kept verbatim;
// only the body is cleaned. The stripped quoted tail + signature are returned as
// a dedicated skip_embedding provenance chunk (chunk_text retained, never
// embedded) so the original stays retrievable.
// ============================================================

import 'server-only'
import { cleanEmail } from './sidecar-client'
import type { FetchedChunk } from './base'

/** FetchedChunk fields shared by the embedded reply chunk and its provenance chunk. */
type EmailChunkTemplate = Omit<FetchedChunk, 'content'>

/**
 * Build the FetchedChunk(s) for one email: a primary chunk whose content is
 * `header + cleaned reply` (or `header + full body` on fail-open), plus an
 * optional provenance chunk for the stripped quoted tail + signature.
 */
export async function buildEmailChunks(
  template: EmailChunkTemplate,
  header: string,
  body: string,
  sender?: string,
): Promise<FetchedChunk[]> {
  const cleaned = await cleanEmail(body, 'text/plain', sender)
  // Fail open: no sidecar / empty reply → embed the full body unchanged.
  const replyBody = cleaned && cleaned.reply_text.trim() ? cleaned.reply_text : body
  const main: FetchedChunk = { ...template, content: header + replyBody }

  if (!cleaned) return [main]

  const tail = [cleaned.quoted_tail, cleaned.signature]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n— — —\n\n')
    .trim()
  if (!tail) return [main]

  const provenance: FetchedChunk = {
    ...template,
    chunk_id: `${template.chunk_id}#quoted`,
    content: tail,
    skip_embedding: true,
    metadata: { ...template.metadata, resource_type: 'email_quoted_tail' },
  }
  return [main, provenance]
}
