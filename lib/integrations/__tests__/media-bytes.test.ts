// ============================================================
// lib/integrations/__tests__/media-bytes.test.ts — P5-4
//
// Parent-context inheritance (connection/visibility/breadcrumb) and origin→bytes
// dispatch: Gmail attachment fetch (revived), the docling_picture provenance-ref
// gap (recognized skip, not a drop), and unimplemented/transient classification.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { dbResponses, gmailFetchMock } = vi.hoisted(() => ({
  dbResponses: [] as Array<{ data?: unknown; error?: unknown }>,
  gmailFetchMock: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/integrations/google/gmail-fetcher', () => ({ fetchGmailAttachment: gmailFetchMock }))

vi.mock('@/lib/supabase/server', () => {
  const nextResponse = () => dbResponses.shift() ?? { data: null, error: null }
  const makeBuilder = () => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'limit']) b[m] = vi.fn(() => b)
    b.maybeSingle = vi.fn(() => Promise.resolve(nextResponse()))
    return b
  }
  return { supabaseAdmin: { from: vi.fn(() => makeBuilder()) } }
})

import {
  resolveParentContext,
  resolveMediaBytes,
  parseGmailMessageId,
  type ParentContext,
} from '@/lib/integrations/media-bytes'
import type { MediaQueueRow } from '@/lib/integrations/media-queue'

const ORG = 'org-1'

beforeEach(() => {
  vi.clearAllMocks()
  dbResponses.length = 0
})

const ctx = (over: Partial<ParentContext> = {}): ParentContext => ({
  documentId: 'doc-1', connectionId: 'conn-1', departmentId: 'dept-1',
  ownerUserId: 'user-1', visibility: 'confidential', provider: 'google',
  title: 'report.pdf', sourceUrl: 'https://x/report.pdf', breadcrumb: 'Drive › report.pdf', ...over,
})

const row = (over: Partial<MediaQueueRow> = {}): MediaQueueRow => ({
  id: 'r1', org_id: ORG, source_doc_id: 'gmail:msg1', sha256: null,
  origin: 'gmail_attachment', bytes_ref: 'att1', caption: null,
  status: 'processing', attempts: 0, ...over,
})

describe('resolveParentContext (P5-4)', () => {
  it('inherits connection, visibility, owner, dept + builds a breadcrumb', async () => {
    dbResponses.push({
      data: {
        id: 'doc-1', connection_id: 'conn-1', department_id: 'dept-1', owner_user_id: 'user-1',
        visibility: 'restricted', source_type: 'google', title: 'Q3 deck.pdf',
        external_url: 'https://drive/x', metadata: { folder_path: 'Finance/Q3' }, context_summary: null,
      },
      error: null,
    })
    const c = await resolveParentContext(ORG, 'drive:abc')
    expect(c).toMatchObject({
      documentId: 'doc-1', connectionId: 'conn-1', visibility: 'restricted',
      ownerUserId: 'user-1', departmentId: 'dept-1', provider: 'google',
      breadcrumb: 'Finance/Q3 › Q3 deck.pdf',
    })
  })

  it('falls back to title-only breadcrumb when no folder path', async () => {
    dbResponses.push({
      data: { id: 'd', connection_id: 'c', visibility: 'department', source_type: 'slack', title: 'photo.png', metadata: {} },
      error: null,
    })
    expect((await resolveParentContext(ORG, 'x'))?.breadcrumb).toBe('photo.png')
  })

  it('returns null when the parent is gone or has no connection (no widening)', async () => {
    dbResponses.push({ data: null, error: null })
    expect(await resolveParentContext(ORG, 'missing')).toBeNull()
    dbResponses.push({ data: { id: 'd', connection_id: null }, error: null })
    expect(await resolveParentContext(ORG, 'noconn')).toBeNull()
  })

  it('returns null on a DB error', async () => {
    dbResponses.push({ data: null, error: { message: 'boom' } })
    expect(await resolveParentContext(ORG, 'x')).toBeNull()
  })
})

describe('parseGmailMessageId (P5-4)', () => {
  it('extracts the message id and rejects malformed refs', () => {
    expect(parseGmailMessageId('gmail:abc123')).toBe('abc123')
    expect(parseGmailMessageId('gmail:abc123:ical:0')).toBe('abc123')
    expect(parseGmailMessageId('drive:xyz')).toBeNull()
  })
})

describe('resolveMediaBytes (P5-4)', () => {
  it('fetches Gmail attachment bytes via the revived fetcher', async () => {
    const bytes = Buffer.from('image-bytes')
    gmailFetchMock.mockResolvedValueOnce(bytes)
    const res = await resolveMediaBytes(row(), ctx())
    expect(res).toEqual({ ok: true, bytes })
    expect(gmailFetchMock).toHaveBeenCalledWith('conn-1', ORG, 'msg1', 'att1')
  })

  it('classifies a Gmail fetch failure as transient (retryable)', async () => {
    gmailFetchMock.mockRejectedValueOnce(new Error('429'))
    expect(await resolveMediaBytes(row(), ctx())).toEqual({ ok: false, reason: 'fetch_error', transient: true })
  })

  it('rejects a malformed gmail source ref and a missing bytes_ref (terminal)', async () => {
    expect(await resolveMediaBytes(row({ source_doc_id: 'drive:x' }), ctx())).toMatchObject({ ok: false, reason: 'bad_source_ref', transient: false })
    expect(await resolveMediaBytes(row({ bytes_ref: null }), ctx())).toMatchObject({ ok: false, reason: 'missing_bytes_ref' })
  })

  it('recognizes docling_picture as an unfetchable provenance ref (P3→P5 blocker, not a drop)', async () => {
    const res = await resolveMediaBytes(row({ origin: 'docling_picture', source_doc_id: 'drive:doc1', bytes_ref: 'doc1.pdf:pic1' }), ctx())
    expect(res).toEqual({ ok: false, reason: 'provenance_ref_unfetchable', transient: false })
  })

  it('recognizes other origins as unimplemented-fetch (tracked follow-up)', async () => {
    for (const origin of ['notion_image', 'slack_file', 'drive_image', 'onedrive_image', 'mystery_origin']) {
      const res = await resolveMediaBytes(row({ origin, source_doc_id: 'x:1', bytes_ref: 'ref' }), ctx())
      expect(res).toMatchObject({ ok: false, reason: 'origin_fetch_unimplemented', transient: false })
    }
  })

  it('skips when there is no inherited connection', async () => {
    expect(await resolveMediaBytes(row(), ctx({ connectionId: '' }))).toMatchObject({ ok: false, reason: 'no_parent_connection' })
  })
})
