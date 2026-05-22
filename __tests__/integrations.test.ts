import { describe, it, expect, vi, beforeEach } from 'vitest';
import { githubIssuesFetcher } from '../lib/integrations/github/issues-fetcher';
import { githubPrsFetcher } from '../lib/integrations/github/prs-fetcher';
import { githubWikiFetcher } from '../lib/integrations/github/wiki-fetcher';
import { linearProjectsFetcher } from '../lib/integrations/linear/projects-fetcher';
import { linearCyclesFetcher } from '../lib/integrations/linear/cycles-fetcher';
import { indexDocument } from '../lib/integrations/indexing';
import { getConnectionToken } from '../lib/nango/client';
import { supabase, supabaseAdmin, supabaseServer } from '../lib/supabase/server';
import { hubspotSearch } from '../lib/integrations/hubspot/searcher';
import { salesforceSearch } from '../lib/integrations/salesforce/searcher';

// Mock dependencies
vi.mock('../lib/nango/client', () => ({
  getConnectionToken: vi.fn(),
}));

vi.mock('../lib/integrations/indexing', () => ({
  indexDocument: vi.fn(),
}));

vi.mock('../lib/supabase/server', () => {
  const mockSupabaseChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: {
        connection_id: 'fake-conn-id',
        metadata: { instance_url: 'https://fake-instance.salesforce.com' },
      },
      error: null,
    }),
    insert: vi.fn().mockResolvedValue({ error: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  };

  const mockSupabaseClient = {
    from: vi.fn(() => mockSupabaseChain),
  };

  return {
    supabase: mockSupabaseClient,
    supabaseAdmin: mockSupabaseClient,
    supabaseServer: mockSupabaseClient,
  };
});

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Integrations Fetchers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GitHub Fetcher', () => {
    it('should fetch issues and construct FetchedChunk array without calling Supabase', async () => {
      (getConnectionToken as any).mockResolvedValue('fake-nango-token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'issue-1',
                    title: 'Test Issue',
                    body: 'Test body',
                    url: 'https://github.com/test/repo/issues/1',
                    createdAt: '2023-01-01T00:00:00Z',
                    comments: { nodes: [{ body: 'Comment 1' }] },
                  },
                ],
              },
            },
          },
        }),
      });

      const chunks = await githubIssuesFetcher('conn-1', 'org-1', 'test_owner', 'test_repo');

      expect(getConnectionToken).toHaveBeenCalledWith('conn-1', 'github', 'org-1');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'issue-1',
        title: 'Test Issue',
        source_url: 'https://github.com/test/repo/issues/1',
        metadata: { 
          provider: 'github', 
          resource_type: 'issue',
          owner: 'test_owner', 
          repo: 'test_repo' 
        },
      });
      expect(chunks[0].content).toContain('Test Issue');
    });

    it('should fetch PRs and construct FetchedChunk array', async () => {
      (getConnectionToken as any).mockResolvedValue('fake-nango-token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'pr-1',
                    title: 'Fix Bug API',
                    body: 'Test PR body',
                    url: 'https://github.com/test/repo/pull/1',
                    createdAt: '2023-01-02T00:00:00Z',
                    reviews: { nodes: [{ body: 'LGTM!' }] },
                  },
                ],
              },
            },
          },
        }),
      });

      const chunks = await githubPrsFetcher('conn-1', 'org-1', 'test_owner', 'test_repo');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'pr-1',
        title: 'Fix Bug API',
        source_url: 'https://github.com/test/repo/pull/1',
        metadata: { 
          provider: 'github', 
          resource_type: 'pull_request',
        },
      });
      expect(chunks[0].content).toContain('LGTM!');
    });

    it('should fetch Wiki pages and construct FetchedChunk array', async () => {
      (getConnectionToken as any).mockResolvedValue('fake-nango-token');
      // Mock Repo info
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ default_branch: 'main' }),
      });
      // Mock Tree
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tree: [{ type: 'blob', path: 'Home.md', sha: 'sha-blob-1' }]
        }),
      });
      // Mock Blob
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          encoding: 'base64',
          content: Buffer.from('Wiki page content').toString('base64'),
        }),
      });

      const chunks = await githubWikiFetcher('conn-1', 'org-1', 'test_owner', 'test_repo');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'gh_wiki_sha-blob-1_0_0',
        title: 'Home',
        source_url: 'https://github.com/test_owner/test_repo/blob/main/Home.md',
        metadata: {
          provider: 'github',
          resource_type: 'markdown_file',
          path: 'Home.md'
        },
      });
      expect(chunks[0].content).toBe('Wiki page content');
    });
  });

  describe('Linear Fetcher', () => {
    it('should fetch projects and construct FetchedChunk array', async () => {
      (getConnectionToken as any).mockResolvedValue('fake-linear-token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'proj-1',
                  name: 'Alpha Project',
                  description: 'Project Desc',
                  url: 'https://linear.app/project/1',
                  createdAt: '2023-01-01T00:00:00Z',
                  projectUpdates: { nodes: [{ body: 'Update 1' }] },
                },
              ],
            },
          },
        }),
      });

      const chunks = await linearProjectsFetcher('conn-2', 'org-1');

      expect(getConnectionToken).toHaveBeenCalledWith('conn-2', 'linear', 'org-1');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'proj-1',
        title: 'Alpha Project',
        source_url: 'https://linear.app/project/1',
        metadata: {
          provider: 'linear',
          resource_type: 'project',
        }
      });
      expect(chunks[0].content).toContain('Alpha Project');
    });

    it('should fetch cycles and construct FetchedChunk array', async () => {
      (getConnectionToken as any).mockResolvedValue('fake-linear-token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            cycles: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'cycle-1',
                  name: 'Sprint 5',
                  description: 'Desc',
                  startsAt: '2023-01-01T00:00:00Z',
                  endsAt: '2023-01-14T00:00:00Z',
                  issues: { nodes: [{ title: 'Do task', state: { name: 'Todo' } }] },
                },
              ],
            },
          },
        }),
      });

      const chunks = await linearCyclesFetcher('conn-2', 'org-1');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'cycle-1',
        title: 'Sprint 5',
        source_url: 'https://linear.app/cycle/cycle-1',
        metadata: {
          provider: 'linear',
          resource_type: 'cycle',
        }
      });
      expect(chunks[0].content).toContain('[Todo] Do task');
      expect(chunks[0].content).toContain('Dates: 2023-01-01T00:00:00Z to 2023-01-14T00:00:00Z');
    });
  });

  describe('HubSpot Searcher', () => {
    it('should search contacts, companies, and deals, and construct FetchedChunk array', async () => {
      (getConnectionToken as any).mockResolvedValue('fake-nango-token');
      
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: 'contact-1',
                properties: {
                  firstname: 'Hub',
                  lastname: 'Spot',
                  description: 'HubSpot Contact Desc',
                },
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: 'company-1',
                properties: {
                  name: 'HubSpot Inc',
                  description: 'HubSpot Company Desc',
                },
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: 'deal-1',
                properties: {
                  dealname: 'Big Deal',
                  description: 'HubSpot Deal Desc',
                },
              },
            ],
          }),
        });

      const chunks = await hubspotSearch('conn-1', 'org-1', 'test query', { limit: 5 });

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'hs-contact-contact-1',
        title: 'Hub Spot',
        content: 'HubSpot Contact Desc',
        source_url: 'https://app.hubspot.com/contacts/contact/contact-1',
        metadata: {
          provider: 'hubspot',
          resource_type: 'contacts',
          id: 'contact-1',
        },
      });
      expect(chunks[1]).toMatchObject({
        chunk_id: 'hs-companie-company-1',
        title: 'HubSpot Inc',
        content: 'HubSpot Company Desc',
      });
      expect(chunks[2]).toMatchObject({
        chunk_id: 'hs-deal-deal-1',
        title: 'Big Deal',
        content: 'HubSpot Deal Desc',
      });
    });
  });

  describe('Salesforce Searcher', () => {
    it('should search accounts, opportunities, and cases, and construct FetchedChunk array', async () => {
      (getConnectionToken as any).mockResolvedValue('fake-nango-token');
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          searchRecords: [
            {
              attributes: { type: 'Account' },
              Id: 'acc-1',
              Name: 'Salesforce Acc',
            },
            {
              attributes: { type: 'Opportunity' },
              Id: 'opp-1',
              Name: 'Salesforce Opp',
            },
            {
              attributes: { type: 'Case' },
              Id: 'case-1',
              Subject: 'Salesforce Case',
            },
          ],
        }),
      });

      const chunks = await salesforceSearch('conn-2', 'org-1', 'test query', { limit: 5 });

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'sf-account-acc-1',
        title: 'Salesforce Acc',
        content: 'Salesforce Acc',
        source_url: 'https://fake-instance.salesforce.com/lightning/r/Account/acc-1/view',
        metadata: {
          provider: 'salesforce',
          resource_type: 'accounts',
          id: 'acc-1',
        },
      });
      expect(chunks[1]).toMatchObject({
        chunk_id: 'sf-opportunity-opp-1',
        title: 'Salesforce Opp',
      });
      expect(chunks[2]).toMatchObject({
        chunk_id: 'sf-case-case-1',
        title: 'Salesforce Case',
      });
    });
  });
});

