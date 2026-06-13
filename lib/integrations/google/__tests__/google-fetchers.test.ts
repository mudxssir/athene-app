import { vi, describe, it, expect, beforeEach } from 'vitest'

// ─── Mock the api-client module ──────────────────────────────────────────────

const mockGoogleFetch = vi.fn()
const mockGoogleFetchRaw = vi.fn()

vi.mock('@/lib/integrations/google/api-client', () => ({
  googleFetch: (...args: any[]) => mockGoogleFetch(...args),
  googleFetchRaw: (...args: any[]) => mockGoogleFetchRaw(...args),
}))

// P3-9: assert media-queue stub enqueues without touching the DB layer.
const mockEnqueueMediaStubs = vi.fn()
vi.mock('@/lib/integrations/binary-parsing', () => ({
  enqueueMediaStubs: (...args: any[]) => mockEnqueueMediaStubs(...args),
}))

import {
  listDriveFiles,
  searchDrive,
  fetchDriveFileContent,
  getStartPageToken,
  fetchChanges,
  driveFileToChunk,
} from '@/lib/integrations/google/drive-fetcher'

import {
  listUnreadEmails,
  fetchEmailBody,
  fetchGmailAttachment,
  sendEmail,
  gmailMetadataToChunk,
  indexEmailChunks,
} from '@/lib/integrations/google/gmail-fetcher'

import {
  fetchCalendarEvents,
  fetchTodayEvents,
  createCalendarEvent,
  calendarEventToChunk,
} from '@/lib/integrations/google/calendar-fetcher'

const CONN = 'test-connection'
const ORG = 'org-123'

// ─── Drive Tests ─────────────────────────────────────────────────────────────

describe('Google Drive Fetcher', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('listDriveFiles constructs the correct API URL with query params', async () => {
    mockGoogleFetch.mockResolvedValue({ files: [], nextPageToken: null })
    await listDriveFiles(CONN, ORG)

    expect(mockGoogleFetch).toHaveBeenCalledOnce()
    const [, , url] = mockGoogleFetch.mock.calls[0]
    expect(url).toContain('https://www.googleapis.com/drive/v3/files')
    expect(url).toContain('trashed%3Dfalse')
  })

  it('listDriveFiles scopes to a folder when folderId is provided', async () => {
    mockGoogleFetch.mockResolvedValue({ files: [{ id: 'f1' }] })
    await listDriveFiles(CONN, ORG, 'folder-abc')

    const [, , url] = mockGoogleFetch.mock.calls[0]
    expect(url).toContain('folder-abc')
    expect(url).toContain('in+parents')
  })

  it('searchDrive escapes single quotes in queries', async () => {
    mockGoogleFetch.mockResolvedValue({ files: [] })
    await searchDrive(CONN, ORG, "user's report")

    const [, , url] = mockGoogleFetch.mock.calls[0]
    expect(url).toContain("user%5C%27s")
    expect(url).toContain('fullText+contains')
  })

  it('fetchDriveFileContent routes Google Docs to export endpoint', async () => {
    mockGoogleFetchRaw.mockResolvedValue({
      text: () => Promise.resolve('Exported plain text content'),
    })
    const result = await fetchDriveFileContent(CONN, ORG, 'doc-123', 'application/vnd.google-apps.document')

    const [, , url] = mockGoogleFetchRaw.mock.calls[0]
    expect(url).toContain('/export?mimeType=text/plain')
    expect(result).toBe('Exported plain text content')
  })

  it('fetchDriveFileContent routes Google Sheets to CSV export', async () => {
    mockGoogleFetchRaw.mockResolvedValue({
      text: () => Promise.resolve('col1,col2\nval1,val2'),
    })
    await fetchDriveFileContent(CONN, ORG, 'sheet-123', 'application/vnd.google-apps.spreadsheet')

    const [, , url] = mockGoogleFetchRaw.mock.calls[0]
    expect(url).toContain('/export?mimeType=text/csv')
  })

  it('fetchDriveFileContent uses alt=media for regular files', async () => {
    mockGoogleFetchRaw.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })
    await fetchDriveFileContent(CONN, ORG, 'file-123', 'application/pdf')

    const [, , url] = mockGoogleFetchRaw.mock.calls[0]
    expect(url).toContain('alt=media')
  })

  it('getStartPageToken calls the correct endpoint', async () => {
    mockGoogleFetch.mockResolvedValue({ startPageToken: 'token-xyz' })
    const token = await getStartPageToken(CONN, ORG)

    expect(token).toBe('token-xyz')
    const [, , url] = mockGoogleFetch.mock.calls[0]
    expect(url).toContain('changes/startPageToken')
  })

  it('fetchChanges returns changes and a new page token', async () => {
    mockGoogleFetch.mockResolvedValue({
      changes: [{ fileId: 'f1', removed: false, file: { id: 'f1', name: 'doc.txt' } }],
      newStartPageToken: 'new-token-456',
    })

    const result = await fetchChanges(CONN, ORG, 'old-token')
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].fileId).toBe('f1')
    expect(result.newPageToken).toBe('new-token-456')
  })

  it('fetchDriveFileContent uses googleFetchRaw and .text() for exports', async () => {
    mockGoogleFetchRaw.mockResolvedValue({
      text: () => Promise.resolve('Raw exported text'),
    })
    const result = await fetchDriveFileContent(CONN, ORG, 'doc-123', 'application/vnd.google-apps.document')

    expect(mockGoogleFetchRaw).toHaveBeenCalledOnce()
    const [, , url] = mockGoogleFetchRaw.mock.calls[0]
    expect(url).toContain('/export?mimeType=text/plain')
    expect(result).toBe('Raw exported text')
  })
})

// ─── Gmail Tests ─────────────────────────────────────────────────────────────

describe('Gmail Fetcher', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('listUnreadEmails returns empty array when no messages exist', async () => {
    mockGoogleFetch.mockResolvedValue({ messages: [] })
    const result = await listUnreadEmails(CONN, ORG)
    expect(result).toEqual([])
  })

  it('listUnreadEmails calls googleFetch', async () => {
    mockGoogleFetch.mockResolvedValueOnce({
      messages: [{ id: 'msg-1', threadId: 't-1' }],
    })
    mockGoogleFetch.mockResolvedValueOnce({
      id: 'msg-1', threadId: 't-1', labelIds: ['UNREAD', 'INBOX'],
      snippet: 'Hey there...',
      payload: { headers: [
        { name: 'From', value: 'alice@example.com' },
        { name: 'Subject', value: 'Test Email' },
        { name: 'Date', value: 'Mon, 20 Apr 2026' },
      ]},
      internalDate: '1745123456000',
    })

    const result = await listUnreadEmails(CONN, ORG, 5)
    expect(result).toHaveLength(1)
    expect(result[0].headers.from).toBe('alice@example.com')
    expect(result[0].headers.subject).toBe('Test Email')
  })

  it('fetchEmailBody decodes base64url plain text body', async () => {
    const base64Body = Buffer.from('Hello, world!').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    mockGoogleFetch.mockResolvedValue({
      id: 'msg-1', threadId: 't-1', labelIds: [], snippet: '',
      payload: { mimeType: 'text/plain', body: { size: 13, data: base64Body } },
    })

    const body = await fetchEmailBody(CONN, ORG, 'msg-1')
    expect(body).toBe('Hello, world!')
  })

  it('fetchEmailBody handles multipart payloads by preferring text/plain', async () => {
    const plainBody = Buffer.from('Plain text version').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_')

    mockGoogleFetch.mockResolvedValue({
      id: 'msg-2', threadId: 't-2', labelIds: [], snippet: '',
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { size: 18, data: plainBody } },
          { mimeType: 'text/html', body: { size: 30, data: 'ignored' } },
        ],
      },
    })

    const body = await fetchEmailBody(CONN, ORG, 'msg-2')
    expect(body).toBe('Plain text version')
  })

  it('fetchGmailAttachment uses googleFetchRaw and decodes base64 data', async () => {
    const attachmentData = Buffer.from('Binary content').toString('base64')
    mockGoogleFetchRaw.mockResolvedValue({
      json: () => Promise.resolve({ data: attachmentData, size: 14 }),
    })

    const result = await fetchGmailAttachment(CONN, ORG, 'msg-123', 'attach-456')
    expect(result.toString()).toBe('Binary content')
    
    const [, , url] = mockGoogleFetchRaw.mock.calls[0]
    expect(url).toContain('/attachments/attach-456')
  })

  it('sendEmail posts a raw base64 message', async () => {
    mockGoogleFetch.mockResolvedValue({ id: 'sent-1', threadId: 't-sent' })
    const result = await sendEmail(CONN, ORG, 'base64-raw-message')

    expect(result.id).toBe('sent-1')
    const [, , url, opts] = mockGoogleFetch.mock.calls[0]
    expect(url).toContain('/messages/send')
    expect(opts.method).toBe('POST')
  })
})

// ─── Calendar Tests ──────────────────────────────────────────────────────────

describe('Google Calendar Fetcher', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('fetchCalendarEvents passes correct time window', async () => {
    mockGoogleFetch.mockResolvedValue({ items: [] })
    const start = new Date('2026-04-20T00:00:00Z')
    const end = new Date('2026-04-21T00:00:00Z')
    await fetchCalendarEvents(CONN, ORG, start, end)

    const [, , url] = mockGoogleFetch.mock.calls[0]
    expect(url).toContain('singleEvents=true')
    expect(url).toContain('orderBy=startTime')
    expect(url).toContain('2026-04-20')
  })

  it('fetchTodayEvents returns events from now to end of day', async () => {
    mockGoogleFetch.mockResolvedValue({
      items: [{ id: 'e1', summary: 'Standup', start: {}, end: {} }],
    })
    const events = await fetchTodayEvents(CONN, ORG)
    expect(events).toHaveLength(1)
    expect(events[0].summary).toBe('Standup')
  })

  it('createCalendarEvent sends a POST', async () => {
    mockGoogleFetch.mockResolvedValue({
      id: 'new-event', summary: 'Team Sync',
      start: { dateTime: '2026-04-20T15:00:00Z' },
      end: { dateTime: '2026-04-20T16:00:00Z' },
    })

    const result = await createCalendarEvent(CONN, ORG, {
      summary: 'Team Sync',
      start: { dateTime: '2026-04-20T15:00:00Z' },
      end: { dateTime: '2026-04-20T16:00:00Z' },
    })

    expect(result.summary).toBe('Team Sync')
    const [, , url, opts] = mockGoogleFetch.mock.calls[0]
    expect(url).toContain('calendars/primary/events')
    expect(opts.method).toBe('POST')
  })
})

// ─── FetchedChunk Builder Tests ──────────────────────────────────────────────

describe('Drive FetchedChunk Builder', () => {
  it('driveFileToChunk produces a valid FetchedChunk', () => {
    const file = {
      id: 'abc123',
      name: 'Q1 Report.pdf',
      mimeType: 'application/pdf',
      webViewLink: 'https://drive.google.com/file/d/abc123/view',
      modifiedTime: '2026-04-20T10:00:00Z',
      owners: [{ displayName: 'Alice', emailAddress: 'alice@example.com' }],
    }

    const chunk = driveFileToChunk(file, 'Extracted PDF text content here...')

    expect(chunk.chunk_id).toBe('drive:abc123')
    expect(chunk.title).toBe('Q1 Report.pdf')
    expect(chunk.content).toBe('Extracted PDF text content here...')
    expect(chunk.source_url).toBe('https://drive.google.com/file/d/abc123/view')
    expect(chunk.metadata.provider).toBe('google')
    expect(chunk.metadata.resource_type).toBe('drive_file')
    expect(chunk.metadata.author).toBe('Alice')
    expect(chunk.metadata.last_modified).toBe('2026-04-20T10:00:00Z')
  })

  it('driveFileToChunk falls back to generated URL when webViewLink is missing', () => {
    const file = {
      id: 'xyz789',
      name: 'Notes.txt',
      mimeType: 'text/plain',
    }

    const chunk = driveFileToChunk(file, 'Some text')
    expect(chunk.source_url).toBe('https://drive.google.com/file/d/xyz789')
  })
})

describe('Gmail FetchedChunk Builder', () => {
  it('gmailMetadataToChunk produces a valid FetchedChunk', () => {
    const msg = {
      id: 'msg-abc',
      threadId: 't-abc',
      labelIds: ['UNREAD', 'INBOX'],
      snippet: 'Hey, just wanted to check in...',
      headers: {
        from: 'bob@example.com',
        subject: 'Quick question',
        date: 'Mon, 20 Apr 2026',
        to: 'alice@example.com',
      },
      internalDate: '1745123456000',
    }

    const chunk = gmailMetadataToChunk(msg)

    expect(chunk.chunk_id).toBe('gmail:msg-abc')
    expect(chunk.title).toBe('Quick question')
    expect(chunk.content).toBe('Hey, just wanted to check in...')
    expect(chunk.source_url).toContain('msg-abc')
    expect(chunk.metadata.provider).toBe('google')
    expect(chunk.metadata.resource_type).toBe('email')
    expect(chunk.metadata.author).toBe('bob@example.com')
  })

  // P3-5 / audit D4: indexEmailChunks emits ONE chunk per email (chunk_id
  // gmail:{id}, no :idx), with a canonical header block (From/To/Cc/Subject/Date)
  // and thread_id — instead of pre-slicing into overlapping per-slice documents.
  it('indexEmailChunks emits one chunk per email with canonical header + thread_id', async () => {
    // base64url body of a long plain-text email (> old 2000-char slice size)
    const longBody = 'This is the body. '.repeat(200) // ~3600 chars
    const bodyB64 = Buffer.from(longBody, 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    mockGoogleFetch.mockImplementation((_c: string, _o: string, url: string) => {
      if (url.includes('/messages?')) {
        return Promise.resolve({ messages: [{ id: 'm-1' }] })
      }
      // full message fetch
      return Promise.resolve({
        id: 'm-1',
        threadId: 'thread-9',
        internalDate: '1745123456000',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'bob@example.com' },
            { name: 'To', value: 'alice@example.com' },
            { name: 'Cc', value: 'carol@example.com' },
            { name: 'Subject', value: 'Quarterly plan' },
            { name: 'Date', value: 'Mon, 20 Apr 2026' },
          ],
          body: { size: longBody.length, data: bodyB64 },
        },
      })
    })

    const chunks = await indexEmailChunks(CONN, ORG, { limit: 10 })

    // Exactly one chunk for the one email (no per-slice fragmentation).
    expect(chunks).toHaveLength(1)
    const c = chunks[0]
    expect(c.chunk_id).toBe('gmail:m-1') // no :idx suffix
    expect(c.metadata.thread_id).toBe('thread-9')
    expect(c.shape).toBe('email')
    // Canonical header block precedes the body, includes Cc.
    expect(c.content).toContain('From: bob@example.com')
    expect(c.content).toContain('To: alice@example.com')
    expect(c.content).toContain('Cc: carol@example.com')
    expect(c.content).toContain('Subject: Quarterly plan')
    // Full body present in the single chunk (not truncated to a 2000-char slice).
    expect(c.content.length).toBeGreaterThan(3000)
  })

  // P3-9 / audit D12: a text/calendar part becomes a record-shape chunk and a
  // binary attachment becomes a media_queue stub (no longer silently dropped).
  it('indexEmailChunks routes calendar parts to record shape + enqueues attachment stubs', async () => {
    mockEnqueueMediaStubs.mockClear()
    const b64 = (s: string) =>
      Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Quarterly Review',
      'DTSTART:20260601T150000Z',
      'DTEND:20260601T160000Z',
      'LOCATION:Room 4',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n')

    mockGoogleFetch.mockImplementation((_c: string, _o: string, url: string) => {
      if (url.includes('/messages?')) return Promise.resolve({ messages: [{ id: 'm-2' }] })
      return Promise.resolve({
        id: 'm-2',
        threadId: 'thread-2',
        internalDate: '1745123456000',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'bob@example.com' },
            { name: 'Subject', value: 'Invite' },
          ],
          parts: [
            { mimeType: 'text/plain', body: { size: 5, data: b64('Hello') } },
            { mimeType: 'text/calendar', body: { size: ics.length, data: b64(ics) } },
            { mimeType: 'application/pdf', filename: 'agenda.pdf', body: { size: 100, attachmentId: 'att-xyz' } },
          ],
        },
      })
    })

    const chunks = await indexEmailChunks(CONN, ORG, { limit: 10 })

    // One email chunk + one calendar record chunk.
    const emailChunk = chunks.find((c) => c.shape === 'email')
    const calChunk = chunks.find((c) => c.shape === 'record')
    expect(emailChunk).toBeDefined()
    expect(calChunk).toBeDefined()
    expect(calChunk!.chunk_id).toBe('gmail:m-2:ical:0')
    expect(calChunk!.content).toContain('Event: Quarterly Review')
    expect(calChunk!.content).toContain('Location: Room 4')
    expect(calChunk!.metadata.resource_type).toBe('calendar_invite')

    // Attachment → media_queue stub (origin gmail_attachment, ref = attachmentId).
    expect(mockEnqueueMediaStubs).toHaveBeenCalledOnce()
    const [orgArg, sourceDocId, pics, origin] = mockEnqueueMediaStubs.mock.calls[0]
    expect(orgArg).toBe(ORG)
    expect(sourceDocId).toBe('gmail:m-2')
    expect(pics).toEqual([{ ref: 'att-xyz' }])
    expect(origin).toBe('gmail_attachment')
  })

  it('gmailMetadataToChunk handles missing subject', () => {
    const msg = {
      id: 'msg-no-subject',
      threadId: 't-1',
      labelIds: [],
      snippet: 'Empty subject line',
      headers: { from: 'test@test.com' },
      internalDate: '1745123456000',
    }

    const chunk = gmailMetadataToChunk(msg)
    expect(chunk.title).toBe('(no subject)')
  })
})

describe('Calendar FetchedChunk Builder', () => {
  it('calendarEventToChunk produces a valid FetchedChunk', () => {
    const event = {
      id: 'evt-123',
      summary: 'Team Standup',
      description: 'Daily sync meeting',
      location: 'Conference Room A',
      start: { dateTime: '2026-04-20T09:00:00Z' },
      end: { dateTime: '2026-04-20T09:30:00Z' },
      attendees: [
        { email: 'alice@example.com', displayName: 'Alice' },
        { email: 'bob@example.com', displayName: 'Bob' },
      ],
      organizer: { email: 'alice@example.com', displayName: 'Alice' },
      htmlLink: 'https://calendar.google.com/calendar/event?eid=evt-123',
      status: 'confirmed',
      updated: '2026-04-19T12:00:00Z',
    }

    const chunk = calendarEventToChunk(event)

    expect(chunk.chunk_id).toBe('calendar:evt-123')
    expect(chunk.title).toBe('Team Standup')
    expect(chunk.content).toContain('Event: Team Standup')
    expect(chunk.content).toContain('Conference Room A')
    expect(chunk.content).toContain('Alice, Bob')
    expect(chunk.metadata.provider).toBe('google')
    expect(chunk.metadata.resource_type).toBe('calendar_event')
    expect(chunk.metadata.author).toBe('Alice')
  })

  it('calendarEventToChunk handles all-day events with date instead of dateTime', () => {
    const event = {
      id: 'evt-allday',
      summary: 'Company Holiday',
      start: { date: '2026-04-25' },
      end: { date: '2026-04-26' },
      status: 'confirmed',
    }

    const chunk = calendarEventToChunk(event)
    expect(chunk.content).toContain('2026-04-25')
    expect(chunk.content).toContain('2026-04-26')
  })
})
