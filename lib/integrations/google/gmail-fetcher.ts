import { googleFetch, googleFetchRaw } from './api-client'
import type { FetchedChunk } from '@/lib/integrations/base'
import { assertSafeMetadata } from '@/lib/integrations/base'
import { type SyncConfig, getSelectedResourceIds } from '@/lib/integrations/sync-config'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GmailMessageRef {
  id: string
  threadId: string
}

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailMessageMetadata {
  id: string
  threadId: string
  labelIds: string[]
  snippet: string
  headers: {
    from?: string
    subject?: string
    date?: string
    to?: string
  }
  internalDate: string
}

export interface GmailMessageFull {
  id: string
  threadId: string
  labelIds: string[]
  snippet: string
  internalDate?: string
  payload: GmailPayloadPart
}

export interface GmailPayloadPart {
  mimeType: string
  headers?: GmailHeader[]
  body?: { size: number; data?: string }
  parts?: GmailPayloadPart[]
}

// ─── Email Listing (Metadata Only) ──────────────────────────────────────────

/**
 * Lists unread emails from the user's Gmail inbox.
 * ⚠️ CRITICAL: Returns METADATA ONLY — bodies are NEVER indexed or cached.
 */
export async function listUnreadEmails(
  connectionId: string,
  orgId: string,
  limit: number = 20
): Promise<GmailMessageMetadata[]> {
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=${limit}`
  const list = await googleFetch<{ messages?: GmailMessageRef[] }>(connectionId, orgId, listUrl)

  if (!list.messages || list.messages.length === 0) return []

  // ATH-30: Fix N+1 problem by processing metadata fetches in small parallel batches
  // to avoid hitting rate limits and improve overall efficiency.
  const BATCH_SIZE = 10
  const results: GmailMessageMetadata[] = []

  for (let i = 0; i < list.messages.length; i += BATCH_SIZE) {
    const batch = list.messages.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (msg) => {
        const metaUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`
        const full = await googleFetch<{
          id: string
          threadId: string
          labelIds: string[]
          snippet: string
          payload: { headers: GmailHeader[] }
          internalDate: string
        }>(connectionId, orgId, metaUrl)

        return {
          id: full.id,
          threadId: full.threadId,
          labelIds: full.labelIds,
          snippet: full.snippet,
          headers: extractHeaders(full.payload.headers),
          internalDate: full.internalDate,
        }
      })
    )
    results.push(...batchResults)
  }

  return results
}

/**
 * Searches Gmail messages using Google's search query syntax.
 */
export async function searchEmails(
  connectionId: string,
  orgId: string,
  query: string,
  limit: number = 10
): Promise<GmailMessageMetadata[]> {
  const encodedQuery = encodeURIComponent(query)
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodedQuery}&maxResults=${limit}`
  const list = await googleFetch<{ messages?: GmailMessageRef[] }>(connectionId, orgId, listUrl)

  if (!list.messages || list.messages.length === 0) return []

  // ATH-30: Fix N+1 problem by processing metadata fetches in small parallel batches
  const BATCH_SIZE = 10
  const results: GmailMessageMetadata[] = []

  for (let i = 0; i < list.messages.length; i += BATCH_SIZE) {
    const batch = list.messages.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.all(
      batch.map(async (msg) => {
        const metaUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`
        const full = await googleFetch<{
          id: string
          threadId: string
          labelIds: string[]
          snippet: string
          payload: { headers: GmailHeader[] }
          internalDate: string
        }>(connectionId, orgId, metaUrl)

        return {
          id: full.id,
          threadId: full.threadId,
          labelIds: full.labelIds,
          snippet: full.snippet,
          headers: extractHeaders(full.payload.headers),
          internalDate: full.internalDate,
        }
      })
    )
    results.push(...batchResults)
  }

  return results
}

// ─── Live Body Fetching ──────────────────────────────────────────────────────

/**
 * Fetches the full body of a specific email.
 * ⚠️ NEVER CACHE THIS — live fetch only, per architectural requirement.
 */
export async function fetchEmailBody(
  connectionId: string,
  orgId: string,
  messageId: string
): Promise<string> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`
  const msg = await googleFetch<GmailMessageFull>(connectionId, orgId, url)
  return extractBodyFromPayload(msg.payload)
}

/**
 * Fetches a Gmail attachment by ID.
 * Returns the raw binary content as a Buffer.
 * ATH-30: Uses googleFetchRaw to correctly handle binary downloads.
 */
export async function fetchGmailAttachment(
  connectionId: string,
  orgId: string,
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`
  
  // Although Gmail returns JSON with base64 data, we use googleFetchRaw
  // to be consistent with Drive and handle potentially large binary chunks safely.
  const res = await googleFetchRaw(connectionId, orgId, url)
  const data = await res.json() as { size: number; data: string }

  if (!data.data) {
    throw new Error(`[gmail-fetcher] Attachment ${attachmentId} contains no data`)
  }

  return Buffer.from(data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

// ─── Sending ─────────────────────────────────────────────────────────────────

/**
 * Sends an email through the authenticated user's Gmail account.
 */
export async function sendEmail(
  connectionId: string,
  orgId: string,
  raw: string
): Promise<{ id: string; threadId: string }> {
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
  return googleFetch<{ id: string; threadId: string }>(connectionId, orgId, url, {
    method: 'POST',
    body: { raw },
  })
}

// ─── FetchedChunk Builders ──────────────────────────────────────────────────

/**
 * Converts a GmailMessageMetadata into a FetchedChunk for the agent's
 * response formatter. Uses snippet + headers only — bodies are NEVER indexed.
 *
 * @param msg - The email metadata from listUnreadEmails or searchEmails.
 * @returns A metadata-only FetchedChunk for display in agent responses.
 */
export function gmailMetadataToChunk(msg: GmailMessageMetadata): FetchedChunk {
  const metadata: FetchedChunk['metadata'] = {
    provider: 'google',
    resource_type: 'email',
    last_modified: new Date(Number(msg.internalDate)).toISOString(),
    author: msg.headers.from,
    thread_id: msg.threadId,
    labels: msg.labelIds.join(','),
  }
  assertSafeMetadata(metadata)

  const subject = msg.headers.subject || '(no subject)'

  return {
    chunk_id: `gmail:${msg.id}`,
    title: subject,
    content: msg.snippet,
    source_url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
    shape: 'email' as const,
    metadata,
  }
}

/**
 * Convenience wrapper: runs searchEmails and returns FetchedChunk[].
 * This is what the agent calls for live Gmail search.
 */
export async function searchEmailChunks(
  connectionId: string,
  orgId: string,
  query: string,
  limit: number = 10,
): Promise<FetchedChunk[]> {
  const results = await searchEmails(connectionId, orgId, query, limit)
  return results.map(gmailMetadataToChunk)
}

// ─── Background Indexing ─────────────────────────────────────────────────────

const CHUNK_SIZE = 2000
const CHUNK_OVERLAP = 200

/**
 * Background indexing fetcher: fetches full email bodies and returns
 * chunked FetchedChunks for embedding. Called by the nango-fetch worker.
 * Unlike searchEmailChunks (live/agent), this indexes full body text.
 */
export async function indexEmailChunks(
  connectionId: string,
  orgId: string,
  options?: { limit?: number; syncConfig?: SyncConfig },
): Promise<FetchedChunk[]> {
  const limit = options?.limit ?? 200

  // browseGmail returns Gmail label IDs (e.g. "Label_123", "INBOX").
  // If the user selected specific labels, only fetch messages from those labels.
  const selectedLabelIds = options?.syncConfig
    ? getSelectedResourceIds(options.syncConfig)
    : null

  let messageRefs: GmailMessageRef[] = []

  if (selectedLabelIds && selectedLabelIds.size > 0) {
    // Fetch per-label and deduplicate (label filter uses AND, so query each separately)
    const seen = new Set<string>()
    for (const labelId of selectedLabelIds) {
      if (messageRefs.length >= limit) break
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=${encodeURIComponent(labelId)}&maxResults=${limit}`
      const list = await googleFetch<{ messages?: GmailMessageRef[] }>(connectionId, orgId, url).catch(() => ({ messages: [] }))
      for (const msg of list.messages ?? []) {
        if (!seen.has(msg.id)) { seen.add(msg.id); messageRefs.push(msg) }
        if (messageRefs.length >= limit) break
      }
    }
  } else {
    // Build time-scoped query: use afterDate if set, otherwise cap to 1 month back
    let timeQuery = 'newer_than:1m'
    if (options?.syncConfig?.afterDate) {
      const d = new Date(options.syncConfig.afterDate)
      if (!isNaN(d.getTime())) {
        const yyyy = d.getUTCFullYear()
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
        const dd = String(d.getUTCDate()).padStart(2, '0')
        timeQuery = `after:${yyyy}/${mm}/${dd}`
      }
    }
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(timeQuery)}&maxResults=${limit}`
    const list = await googleFetch<{ messages?: GmailMessageRef[] }>(connectionId, orgId, listUrl)
    messageRefs = list.messages ?? []
  }

  if (messageRefs.length === 0) return []

  const BATCH_SIZE = 10
  const chunks: FetchedChunk[] = []

  for (let i = 0; i < messageRefs.length; i += BATCH_SIZE) {
    const batch = messageRefs.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async (msg) => {
        try {
          const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`
          const full = await googleFetch<GmailMessageFull>(connectionId, orgId, url)
          const headers = extractHeaders(full.payload.headers ?? [])
          const body = extractBodyFromPayload(full.payload)
          const prefix = [
            headers.from    ? `From: ${headers.from}`    : null,
            headers.to      ? `To: ${headers.to}`        : null,
            headers.subject ? `Subject: ${headers.subject}` : null,
            headers.date    ? `Date: ${headers.date}`    : null,
          ].filter(Boolean).join('\n') + '\n\n'

          const fullText = prefix + body
          const msgChunks: FetchedChunk[] = []
          let offset = 0
          let idx = 0
          while (offset < fullText.length) {
            const slice = fullText.slice(offset, offset + CHUNK_SIZE)
            const metadata = {
              provider: 'google',
              resource_type: 'email',
              last_modified: new Date(Number(full.internalDate ?? 0)).toISOString(),
              author: headers.from,
              thread_id: full.threadId,
            }
            assertSafeMetadata(metadata)

            msgChunks.push({
              chunk_id: `gmail:${msg.id}:${idx}`,
              title: headers.subject || '(no subject)',
              content: slice,
              source_url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
              shape: 'email' as const,
              metadata,
            })
            offset += CHUNK_SIZE - CHUNK_OVERLAP
            idx++
          }
          return msgChunks
        } catch {
          return []
        }
      })
    )
    for (const r of results) chunks.push(...r)
  }

  return chunks
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

function extractHeaders(headers: GmailHeader[]): GmailMessageMetadata['headers'] {
  const result: GmailMessageMetadata['headers'] = {}
  for (const h of headers) {
    const key = h.name.toLowerCase()
    if (key === 'from') result.from = h.value
    if (key === 'subject') result.subject = h.value
    if (key === 'date') result.date = h.value
    if (key === 'to') result.to = h.value
  }
  return result
}

function extractBodyFromPayload(payload: GmailPayloadPart): string {
  if (payload.body?.data && payload.mimeType === 'text/plain') {
    return decodeBase64Url(payload.body.data)
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
    }

    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = decodeBase64Url(part.body.data)
        return stripHtmlTags(html)
      }
    }

    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBodyFromPayload(part)
        if (nested) return nested
      }
    }
  }

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }

  return '[No readable body content found]'
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
}
