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
          messages: [{ ts: '1714123456.000100', text: 'Hello team, here is the deployment plan for the new release tomorrow', user: 'U123' }],
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
          messages: [{ ts: '1714123456.000100', text: 'Quick update on the migration progress for everyone following along here', user: 'U123' }],
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

    it('emits replies as a windowed child chunk (slack-msg-{ch}-{ts}:r{n})', async () => {
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'gen', is_archived: false }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, has_more: false, messages: [{ ts: '100.000', text: 'Parent', user: 'U1', thread_ts: '100.000', reply_count: 1 }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: '100.000', text: 'Parent', user: 'U1' }, { ts: '101.000', text: 'Reply one', user: 'U2' }] }) })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')
      const window = chunks.find((c) => c.chunk_id === 'slack-msg-C1-100.000:r0')
      expect(window).toBeDefined()
      expect(window!.content).toBe('Reply one')
      expect(window!.metadata.resource_type).toBe('channel_reply_window')
      expect(window!.metadata.parent_chunk_id).toBe('slack-msg-C1-100.000')
      expect(window!.metadata.window_index).toBe(0)
    })

    it('groups replies into windows of 10 — full windows stay stable, only the tail mutates', async () => {
      mockTeamInfo()
      const replies = Array.from({ length: 12 }, (_, i) => ({
        ts: `${201 + i}.000`, text: `Reply number ${i + 1}`, user: `U${i + 2}`,
      }))
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'gen', is_archived: false }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, has_more: false, messages: [{ ts: '200.000', text: 'Q', user: 'U1', thread_ts: '200.000', reply_count: 12 }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: '200.000', text: 'Q', user: 'U1' }, ...replies] }) })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')
      // 1 parent + 2 windows (10 + 2)
      expect(chunks).toHaveLength(3)
      const w0 = chunks.find((c) => c.chunk_id === 'slack-msg-C1-200.000:r0')
      const w1 = chunks.find((c) => c.chunk_id === 'slack-msg-C1-200.000:r1')
      expect(w0).toBeDefined()
      expect(w1).toBeDefined()
      expect(w0!.content).toContain('Reply number 1')
      expect(w0!.content).toContain('Reply number 10')
      expect(w0!.content).not.toContain('Reply number 11')
      expect(w1!.content).toContain('Reply number 11')
      expect(w1!.content).toContain('Reply number 12')
      // A 13th reply would change ONLY w1's content; w0 and the parent keep
      // their content (hash-stable) — that is the append-only invariant.
    })

    it('skips short messages (<10 tokens) without replies, keeps short thread anchors', async () => {
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'gen', is_archived: false }] }) })
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          ok: true, has_more: false,
          messages: [
            { ts: '300.000', text: '+1', user: 'U1' },                 // short, no replies → skipped
            { ts: '301.000', text: 'lgtm', user: 'U2' },               // short, no replies → skipped
            { ts: '302.000', text: 'deploy?', user: 'U3', thread_ts: '302.000', reply_count: 1 }, // short but anchors a thread → kept
          ],
        }),
      })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: '302.000', text: 'deploy?', user: 'U3' }, { ts: '303.000', text: 'Yes, deploying at 5pm after the standup discussion concludes today', user: 'U4' }] }) })

      const chunks = await fetchSlackMessages('conn-1', 'org-1')
      expect(chunks.find((c) => c.chunk_id === 'slack-msg-C1-300.000')).toBeUndefined()
      expect(chunks.find((c) => c.chunk_id === 'slack-msg-C1-301.000')).toBeUndefined()
      expect(chunks.find((c) => c.chunk_id === 'slack-msg-C1-302.000')).toBeDefined()
      expect(chunks.find((c) => c.chunk_id === 'slack-msg-C1-302.000:r0')).toBeDefined()
    })

    it('skips bot messages unless the bot is allowlisted in syncConfig', async () => {
      const botMsg = { ts: '400.000', text: 'Standup summary: Alice finished the auth refactor and Bob starts on billing today', user: 'B1', bot_id: 'B-STANDUP' }

      // Run 1: no allowlist → bot skipped
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'gen', is_archived: false }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, has_more: false, messages: [botMsg] }) })
      const withoutAllowlist = await fetchSlackMessages('conn-1', 'org-1')
      expect(withoutAllowlist).toHaveLength(0)

      // Run 2: allowlisted → bot indexed
      mockTeamInfo()
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'gen', is_archived: false }] }) })
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, has_more: false, messages: [botMsg] }) })
      const withAllowlist = await fetchSlackMessages('conn-1', 'org-1', { mode: 'all', botAllowlist: ['B-STANDUP'] })
      expect(withAllowlist).toHaveLength(1)
      expect(withAllowlist[0].content).toContain('Standup summary')
    })
  })
})
