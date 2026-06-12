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
    getProviderToken: vi.fn().mockResolvedValue('fake-zendesk-token'),
    getProviderMetadata: vi.fn().mockResolvedValue({ subdomain: 'help' }),
  }
})

import { fetchZendeskTickets } from '../tickets-fetcher'
import { fetchZendeskArticles } from '../articles-fetcher'
import { searchZendesk } from '../searcher'
import { getProviderToken } from '@/lib/integrations/base'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('Zendesk Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getProviderToken).mockResolvedValue('fake-zendesk-token')
  })

  describe('fetchZendeskTickets', () => {
    it('returns FetchedChunk[] with comments (Happy Path)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null },
        json: async () => ({ tickets: [{ id: 1, subject: 'S', status: 'o', updated_at: '2024', url: 'https://h.z.com/api/v2/tickets/1.json' }], next_page: null }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null },
        json: async () => ({ comments: [{ id: 101, public: true, body: 'C' }] }),
      })

      const chunks = await fetchZendeskTickets('conn-1', 'org-1', 'help')
      expect(chunks).toHaveLength(1)
      expect(chunks[0].chunk_id).toBe('zendesk-ticket-1')
      expect(getProviderToken).toHaveBeenCalledWith('conn-1', 'zendesk', 'org-1')
    })

    it('emits structured_owners for assignee_id (OWNS) and requester_id (REPORTED_BY)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null },
        json: async () => ({
          tickets: [{ id: 2, subject: 'T', status: 'open', updated_at: '2024', url: 'https://h.z.com/api/v2/tickets/2.json', assignee_id: 101, requester_id: 202 }],
          next_page: null,
        }),
      })
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null },
        json: async () => ({ comments: [] }),
      })

      const chunks = await fetchZendeskTickets('conn-1', 'org-1', 'help')
      const owners = chunks[0].structured_owners ?? []
      expect(owners.find(o => o.relation === 'OWNS')).toMatchObject({ provider_account_id: '101' })
      expect(owners.find(o => o.relation === 'REPORTED_BY')).toMatchObject({ provider_account_id: '202' })
    })
  })

  describe('fetchZendeskArticles', () => {
    it('fetches articles and strips HTML', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null },
        json: async () => ({ articles: [{ id: 50, title: 'F', body: '<p>H</p>', draft: false, updated_at: '2024', html_url: 'u' }], next_page: null }),
      })

      const chunks = await fetchZendeskArticles('conn-1', 'org-1', 'help')
      expect(chunks).toHaveLength(1)
      expect(chunks[0].content).toContain('H')
    })
  })

  describe('searchZendesk', () => {
    it('returns search results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true, status: 200,
        headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null },
        json: async () => ({ results: [{ id: 1, result_type: 'ticket', subject: 'S', description: 'D', url: 'u' }] }),
      })

      const results = await searchZendesk('conn-1', 'org-1', 'help', 'q')
      expect(results).toHaveLength(1)
      expect(results[0].chunk_id).toBe('zendesk-search-ticket-1')
    })
  })
})
