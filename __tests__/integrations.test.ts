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

import { lookerSearch } from '../lib/integrations/looker/searcher';
import { lookerFetch, lookerInstanceUrl } from '../lib/integrations/looker/client';
import { metabaseSearch } from '../lib/integrations/metabase/searcher';
import { metabaseFetch } from '../lib/integrations/metabase/client';
import { tableauSearch } from '../lib/integrations/tableau/searcher';
import { tableauSignIn, tableauFetch } from '../lib/integrations/tableau/client';
import { redshiftSearch } from '../lib/integrations/redshift/searcher';
import { getRedshiftCredentials, redshiftQuery, listRedshiftTables } from '../lib/integrations/redshift/client';
import { searchSlack } from '../lib/integrations/slack/searcher';
import { bigquerySearch } from '../lib/integrations/bigquery/searcher';
import { listBigQueryTables, bigqueryFetch, bigqueryProjectId } from '../lib/integrations/bigquery/client';
import { dbtSearch } from '../lib/integrations/dbt/searcher';
import { dbtFetch, dbtAccountId } from '../lib/integrations/dbt/client';
import { powerbiSearch } from '../lib/integrations/powerbi/searcher';
import { powerbiFetch, powerbiFetchScoped, listWorkspaces } from '../lib/integrations/powerbi/client';


// Mock dependencies
vi.mock('../lib/nango/client', () => ({
  getConnectionToken: vi.fn(),
}));

vi.mock('../lib/integrations/indexing', () => ({
  indexDocument: vi.fn(),
}));

const mockGetConnection = vi.fn();
vi.mock('@nangohq/node', () => ({
  Nango: class {
    getConnection = mockGetConnection;
  },
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

process.env.NANGO_SECRET_KEY = 'test-secret';

describe('Integrations Fetchers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockGetConnection.mockReset();
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

  describe('Looker Integration', () => {
    it('should fetch Looker instance URL', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { instance_url: 'https://looker.example.com/' },
      });
      const url = await lookerInstanceUrl('conn-looker', 'org-1');
      expect(url).toBe('https://looker.example.com');
    });

    it('should throw if Looker instance URL is missing', async () => {
      mockGetConnection.mockResolvedValue({ metadata: {} });
      await expect(lookerInstanceUrl('conn-looker', 'org-1')).rejects.toThrow();
    });

    it('should search looker looks and dashboards', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { instance_url: 'https://looker.example.com/' },
      });
      (getConnectionToken as any).mockResolvedValue('fake-token');

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ id: 1, title: 'My Look', description: 'Desc' }],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ id: 2, title: 'My Dash' }],
        });

      const chunks = await lookerSearch('conn-looker', 'org-1', 'testquery');
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'looker_look_1',
        title: 'Looker Look: My Look',
        content: 'Desc',
        source_url: 'https://looker.example.com/looks/1',
      });
      expect(chunks[1]).toMatchObject({
        chunk_id: 'looker_dashboard_2',
        title: 'Looker Dashboard: My Dash',
        content: 'My Dash',
        source_url: 'https://looker.example.com/dashboards/2',
      });
    });

    it('should handle search errors and return empty array', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { instance_url: 'https://looker.example.com/' },
      });
      (getConnectionToken as any).mockResolvedValue('fake-token');
      mockFetch.mockRejectedValue(new Error('API Error'));

      const chunks = await lookerSearch('conn-looker', 'org-1', 'testquery');
      expect(chunks).toHaveLength(0);
    });
  });

  describe('Metabase Integration', () => {
    it('should fetch and search cards/dashboards', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { instance_url: 'https://metabase.example.com', api_key: 'mb-key' },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 10, model: 'card', name: 'Sales Card', description: 'Sales Desc' },
            { id: 20, model: 'dashboard', name: 'Sales Dash' },
          ],
        }),
      });

      const chunks = await metabaseSearch('conn-metabase', 'org-1', 'sales');
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'metabase_card_10',
        title: 'Metabase Question: Sales Card',
        content: 'Sales Desc',
        source_url: 'https://metabase.example.com/question/10',
      });
      expect(chunks[1]).toMatchObject({
        chunk_id: 'metabase_dashboard_20',
        title: 'Metabase Dashboard: Sales Dash',
        content: 'Sales Dash',
        source_url: 'https://metabase.example.com/dashboard/20',
      });
    });

    it('should throw metabaseFetch if api_key or instance_url is missing', async () => {
      mockGetConnection.mockResolvedValue({ metadata: {} });
      await expect(metabaseFetch('conn-metabase', 'org-1', '/search')).rejects.toThrow();
    });

    it('should return empty array on metabase search error', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { instance_url: 'https://metabase.example.com', api_key: 'mb-key' },
      });
      mockFetch.mockRejectedValue(new Error('API Error'));
      const chunks = await metabaseSearch('conn-metabase', 'org-1', 'sales');
      expect(chunks).toHaveLength(0);
    });
  });

  describe('Tableau Integration', () => {
    it('should sign in and search workbooks/views', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { server_url: 'https://tableau.example.com', token_name: 'tname', token_value: 'tval', site_name: 'siteA' },
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            credentials: { token: 'tab-token', site: { id: 'site-id-123' } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            workbooks: { workbook: [{ id: 'wb-1', name: 'Sales WB', webpageUrl: 'https://custom-url' }] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            views: { view: [{ id: 'v-1', name: 'Sales View', contentUrl: 'sales-v' }] },
          }),
        });

      const chunks = await tableauSearch('conn-tableau', 'org-1', 'Sales');
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'tableau_workbook_wb-1',
        title: 'Tableau: Sales WB',
        source_url: 'https://custom-url',
      });
      expect(chunks[1]).toMatchObject({
        chunk_id: 'tableau_view_v-1',
        title: 'Tableau View: Sales View',
        source_url: 'https://tableau.example.com/#/views/sales-v',
      });
    });

    it('should fall back to serverUrl if webpageUrl is missing in workbook search', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { server_url: 'https://tableau.example.com', token_name: 'tname', token_value: 'tval' },
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            credentials: { token: 'tab-token', site: { id: 'site-id-123' } },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            workbooks: { workbook: [{ id: 'wb-1', name: 'Sales WB' }] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ views: { view: [] } }),
        });

      const chunks = await tableauSearch('conn-tableau', 'org-1', 'Sales');
      expect(chunks[0].source_url).toBe('https://tableau.example.com/#/workbooks/wb-1');
    });

    it('should throw if token or site id missing in sign-in response', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { server_url: 'https://tableau.example.com', token_name: 'tname', token_value: 'tval' },
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ credentials: {} }),
      });
      await expect(tableauSignIn('conn-tableau', 'org-1')).rejects.toThrow();
    });

    it('should throw if tableau parameters are missing', async () => {
      mockGetConnection.mockResolvedValue({ metadata: {} });
      await expect(tableauSignIn('conn-tableau', 'org-1')).rejects.toThrow();
    });
  });

  describe('Redshift Integration', () => {
    const fakeCreds = {
      region: 'us-east-1',
      clusterId: 'my-cluster',
      dbUser: 'dbuser',
      database: 'mydb',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      allowlist: ['public.table1'],
    };

    it('should retrieve credentials', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: {
          region: 'us-east-1',
          cluster_id: 'my-cluster',
          db_user: 'dbuser',
          database: 'mydb',
          access_key_id: 'ak',
          secret_access_key: 'sk',
          allowlist: ['public.table1'],
        },
      });

      const creds = await getRedshiftCredentials('conn-redshift', 'org-1');
      expect(creds).toMatchObject(fakeCreds);
    });

    it('should query redshift', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Id: 'stmt-123' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Status: 'FINISHED' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ColumnMetadata: [{ name: 'col1' }],
          Records: [[{ stringValue: 'hello' }]],
        }),
      });

      const rows = await redshiftQuery(fakeCreds, 'SELECT * FROM test');
      expect(rows).toEqual([{ col1: 'hello' }]);
    });

    it('should fail execute statement if fetch is not ok', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      });
      await expect(redshiftQuery(fakeCreds, 'SELECT * FROM test')).rejects.toThrow('Redshift ExecuteStatement failed');
    });

    it('should fail poll statement if status is FAILED', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Id: 'stmt-123' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Status: 'FAILED', Error: 'syntax error' }),
      });
      await expect(redshiftQuery(fakeCreds, 'SELECT * FROM test')).rejects.toThrow('Redshift query failed: syntax error');
    });

    it('should list redshift tables', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: {
          region: 'us-east-1',
          cluster_id: 'my-cluster',
          db_user: 'dbuser',
          database: 'mydb',
          access_key_id: 'ak',
          secret_access_key: 'sk',
        },
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ Id: 'stmt-123' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ Status: 'FINISHED' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ColumnMetadata: [{ name: 'table_schema' }, { name: 'table_name' }],
            Records: [[{ stringValue: 'public' }, { stringValue: 'table1' }]],
          }),
        });

      const tables = await listRedshiftTables('conn-redshift', 'org-1');
      expect(tables).toEqual([{ schema: 'public', name: 'table1', fullName: 'public.table1' }]);
    });

    it('should search redshift', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: {
          region: 'us-east-1',
          cluster_id: 'my-cluster',
          db_user: 'dbuser',
          database: 'mydb',
          access_key_id: 'ak',
          secret_access_key: 'sk',
          allowlist: ['public.table1'],
        },
      });

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ Id: 'stmt-col' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ Status: 'FINISHED' }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ColumnMetadata: [{ name: 'column_name' }],
            Records: [[{ stringValue: 'col_text' }]],
          }),
        });

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ Id: 'stmt-search' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ Status: 'FINISHED' }) })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ColumnMetadata: [{ name: 'col_text' }],
            Records: [[{ stringValue: 'some text matching query' }]],
          }),
        });

      const chunks = await redshiftSearch('conn-redshift', 'org-1', 'matching');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'redshift_search_public_table1_0',
        title: 'Redshift result: table1',
        content: 'col_text: some text matching query',
      });
    });
  });

  describe('Slack Integration', () => {
    it('should search slack messages', async () => {
      (getConnectionToken as any).mockResolvedValue('slack-token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          messages: {
            matches: [
              {
                channel: { id: 'chan-1', name: 'general' },
                ts: '12345.67',
                text: 'hello from slack channel general',
                permalink: 'https://slack.com/archives/chan-1/p1234567',
                username: 'alice',
              },
            ],
          },
        }),
      });

      const chunks = await searchSlack('conn-slack', 'org-1', 'hello');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'slack-search-chan-1-12345.67',
        title: '#general: hello from slack channel general...',
        content: 'hello from slack channel general',
        source_url: 'https://slack.com/archives/chan-1/p1234567',
      });
    });

    it('should throw if slackFetch returns ok: false', async () => {
      (getConnectionToken as any).mockResolvedValue('slack-token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'invalid_auth' }),
      });

      await expect(searchSlack('conn-slack', 'org-1', 'hello')).rejects.toThrow('Slack API error on search.messages: invalid_auth');
    });
  });

  describe('BigQuery Integration', () => {
    it('should fetch project ID and search tables', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { project_id: 'my-project-123' },
      });
      (getConnectionToken as any).mockResolvedValue('bq-token');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          datasets: [{ datasetReference: { datasetId: 'dataset1' } }],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tables: [{ tableReference: { tableId: 'table1' } }],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          schema: { fields: [{ name: 'col1' }] },
          rows: [{ f: [{ v: 'matching value' }] }],
        }),
      });

      const chunks = await bigquerySearch('conn-bq', 'org-1', 'matching');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'bigquery_search_dataset1_table1_0',
        title: 'BigQuery result: dataset1.table1',
        content: 'col1: matching value',
        source_url: 'https://console.cloud.google.com/bigquery?project=my-project-123&p=my-project-123&d=dataset1&t=table1&page=table',
      });
    });

    it('should list bigquery tables', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { project_id: 'my-project-123' },
      });
      (getConnectionToken as any).mockResolvedValue('bq-token');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          datasets: [{ datasetReference: { datasetId: 'ds1' } }],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tables: [{ tableReference: { tableId: 'tbl1' } }],
        }),
      });

      const tables = await listBigQueryTables('conn-bq', 'org-1');
      expect(tables).toEqual([{ dataset: 'ds1', name: 'tbl1', fullName: 'ds1.tbl1' }]);
    });

    it('should throw if project_id missing in bigqueryProjectId', async () => {
      mockGetConnection.mockResolvedValue({ metadata: {} });
      await expect(bigqueryProjectId('conn-bq', 'org-1')).rejects.toThrow('BigQuery project_id not found');
    });

    it('should throw if project_id missing in bigqueryFetch', async () => {
      mockGetConnection.mockResolvedValue({ metadata: {} });
      await expect(bigqueryFetch('conn-bq', 'org-1', '/datasets')).rejects.toThrow('BigQuery project_id not found');
    });
  });

  describe('DBT Integration', () => {
    it('should search jobs and models', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { account_id: 'dbt-account-99' },
      });
      (getConnectionToken as any).mockResolvedValue('dbt-token');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 101, name: 'My job name', description: 'Runs daily', project_id: 11 }],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ unique_id: 'model-202', name: 'orders_model', description: 'Orders data model' }],
        }),
      });

      const chunks = await dbtSearch('conn-dbt', 'org-1', 'job');
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'dbt_job_101',
        title: 'dbt Job: My job name',
        content: 'Runs daily',
        source_url: 'https://cloud.getdbt.com/deploy/11/jobs/101',
      });
      expect(chunks[1]).toMatchObject({
        chunk_id: 'dbt_model_model-202',
        title: 'dbt Model: orders_model',
        content: 'Orders data model',
      });
    });

    it('should retrieve dbtAccountId', async () => {
      mockGetConnection.mockResolvedValue({
        metadata: { account_id: 'dbt-account-99' },
      });
      const id = await dbtAccountId('conn-dbt', 'org-1');
      expect(id).toBe('dbt-account-99');
    });

    it('should throw if account_id is missing in dbtFetch', async () => {
      mockGetConnection.mockResolvedValue({ metadata: {} });
      await expect(dbtFetch('conn-dbt', 'org-1', '/jobs/')).rejects.toThrow();
    });
  });

  describe('PowerBI Integration', () => {
    it('should search reports and datasets', async () => {
      (getConnectionToken as any).mockResolvedValue('pb-token');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ id: 'rep-1', name: 'Q1 Sales Report', description: 'Q1 metrics', webUrl: 'https://pb.com/rep1' }],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ id: 'ds-1', name: 'Q1 Dataset' }],
        }),
      });

      const chunks = await powerbiSearch('conn-pb', 'org-1', 'Q1');
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toMatchObject({
        chunk_id: 'powerbi_report_rep-1',
        title: 'Power BI Report: Q1 Sales Report',
        content: 'Q1 metrics',
        source_url: 'https://pb.com/rep1',
      });
      expect(chunks[1]).toMatchObject({
        chunk_id: 'powerbi_dataset_ds-1',
        title: 'Power BI Dataset: Q1 Dataset',
        content: 'Dataset: Q1 Dataset',
        source_url: 'https://app.powerbi.com/datasets/ds-1',
      });
    });

    it('should list workspaces and fallback to user scope on admin failure', async () => {
      (getConnectionToken as any).mockResolvedValue('pb-token');

      mockFetch.mockRejectedValueOnce(new Error('Forbidden'));
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ id: 'group-1', name: 'Group 1', type: 'Workspace', isReadOnly: false, isOnDedicatedCapacity: false }],
        }),
      });

      const list = await listWorkspaces('conn-pb', 'org-1');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'group-1', name: 'Group 1' });
    });

    it('should use admin scope if available', async () => {
      (getConnectionToken as any).mockResolvedValue('pb-token');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [{ id: 'admin-group-1', name: 'Admin Group 1' }],
        }),
      });

      const list = await listWorkspaces('conn-pb', 'org-1');
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'admin-group-1', name: 'Admin Group 1' });
    });

    it('should test powerbiFetchScoped', async () => {
      (getConnectionToken as any).mockResolvedValue('pb-token');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'ok' }),
      });

      const res = await powerbiFetchScoped('conn-pb', 'org-1', 'grp-123', '/reports');
      expect(res).toEqual({ status: 'ok' });
    });
  });
});

