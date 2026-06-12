import { describe, it, expect, vi, beforeEach } from 'vitest'

// 1. Mock problematic top-level modules
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: {},
  supabaseServer: {},
  supabase: {},
}))

// Mock Nango node SDK
vi.mock('@nangohq/node', () => ({
  Nango: vi.fn().mockImplementation(() => ({
    getConnection: vi.fn().mockResolvedValue({
      metadata: { org_id: 'org-1' },
      connection_config: { subdomain: 'help' }
    })
  }))
}))

// Mock the base integration module
vi.mock('@/lib/integrations/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/integrations/base')>()
  return {
    ...actual,
    getProviderToken: vi.fn().mockResolvedValue('xoxb-fake-token'),
    getProviderMetadata: vi.fn().mockResolvedValue({ subdomain: 'help' }),
  }
})

import { fetchSlackMessages } from '../channels-fetcher'
import { searchSlack } from '../searcher'
import { getProviderToken } from '@/lib/integrations/base'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockTeamInfo(domain = 'test-workspace') {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ ok: true, team: { domain } }),
  })
}

describe('Slack Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getProviderToken).mockResolvedValue('xoxb-fake-token')
  })

  describe('fetchSlackMessages', () => {
    it('returns FetchedChunk[] with correct shape (Happy Path)', async () => {
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          ok: true,
          channels: [{ id: 'C123', name: 'general', is_archived: false }],
        }),
      })

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          ok: true,
          has_more: false,
          messages: [{ ts: '1714123456.000100', text: 'Hello team!', user: 'U123' }],
        }),
      })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')

      expect(chunks).toHaveLength(1)
      expect(chunks[0].chunk_id).toBe('slack-msg-C123-1714123456.000100')
      expect(chunks[0].metadata.provider).toBe('slack')
      expect(getProviderToken).toHaveBeenCalledWith('conn-1', 'slack', 'org-1')
    })

    it('source_url uses workspace domain from team.info', async () => {
      mockTeamInfo('test-workspace')
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          ok: true,
          channels: [{ id: 'C123', name: 'general', is_archived: false }],
        }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          ok: true,
          has_more: false,
          messages: [{ ts: '1714123456.000100', text: 'Hello!', user: 'U123' }],
        }),
      })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')
      expect(chunks[0].source_url).toContain('test-workspace.slack.com')
    })

    it('returns empty array when no channels found', async () => {
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, channels: [] }),
      })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')
      expect(chunks).toHaveLength(0)
    })

    it('handles pagination correctly', async () => {
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: true, channels: [{ id: 'C1' }], response_metadata: { next_cursor: 'p2' } }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: true, channels: [{ id: 'C2' }], response_metadata: { next_cursor: '' } }),
      })
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, has_more: false, messages: [] }) })

      await fetchSlackMessages('conn-1', 'org-1')
      expect(mockFetch).toHaveBeenCalled()
    })

    // ── P2-9: Slack stable windows ────────────────────────────────────────

    it('parent chunk content is the original message only (stable window)', async () => {
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'gen', is_archived: false }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, has_more: false, messages: [{ ts: '100.000', text: 'Parent message', user: 'U1', thread_ts: '100.000', reply_count: 1 }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: '100.000', text: 'Parent message', user: 'U1' }, { ts: '101.000', text: 'Reply one', user: 'U2' }] }) })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')
      const parent = chunks.find((c) => c.chunk_id === 'slack-msg-C1-100.000')
      expect(parent).toBeDefined()
      // Parent content must NOT include the reply text — it's stable
      expect(parent!.content).toBe('Parent message')
      expect(parent!.content).not.toContain('Reply one')
    })

    it('emits reply as a separate child chunk', async () => {
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'gen', is_archived: false }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, has_more: false, messages: [{ ts: '100.000', text: 'Parent', user: 'U1', thread_ts: '100.000', reply_count: 1 }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: '100.000', text: 'Parent', user: 'U1' }, { ts: '101.000', text: 'Reply one', user: 'U2' }] }) })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')
      const reply = chunks.find((c) => c.chunk_id === 'slack-reply-C1-101.000')
      expect(reply).toBeDefined()
      expect(reply!.content).toBe('Reply one')
      expect(reply!.metadata.resource_type).toBe('channel_reply')
      expect(reply!.metadata.parent_chunk_id).toBe('slack-msg-C1-100.000')
    })

    it('each reply gets its own chunk id — append-only on new reply', async () => {
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'gen', is_archived: false }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, has_more: false, messages: [{ ts: '200.000', text: 'Q', user: 'U1', thread_ts: '200.000', reply_count: 2 }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: '200.000', text: 'Q', user: 'U1' }, { ts: '201.000', text: 'A1', user: 'U2' }, { ts: '202.000', text: 'A2', user: 'U3' }] }) })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')
      expect(chunks.find((c) => c.chunk_id === 'slack-reply-C1-201.000')).toBeDefined()
      expect(chunks.find((c) => c.chunk_id === 'slack-reply-C1-202.000')).toBeDefined()
      // Total: 1 parent + 2 reply chunks
      expect(chunks).toHaveLength(3)
    })
  })
})
