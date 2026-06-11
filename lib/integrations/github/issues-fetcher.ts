import { githubFetch } from './client';
import { FetchedChunk } from '../base';

const ISSUES_QUERY = `
  query GetIssues($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 50, after: $cursor, states: [OPEN, CLOSED]) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          body
          url
          createdAt
          comments(first: 50) {
            nodes {
              body
            }
          }
        }
      }
    }
  }
`;

export async function githubIssuesFetcher(connectionId: string, orgId: string, owner: string, repo: string): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: any = await githubFetch(connectionId, orgId, ISSUES_QUERY, { owner, repo, cursor });
    
    const issuesResult = data.data?.repository?.issues;
    if (!issuesResult) break;

    for (const issue of issuesResult.nodes) {
      const allComments = issue.comments?.nodes?.map((c: any) => c.body).join('\n---\n') || '';
      const fullContent = `Issue: ${issue.title}\n\n${issue.body}\n\nComments:\n${allComments}`;
      
      const chunk: FetchedChunk = {
        chunk_id: issue.id,
        title: issue.title,
        content: fullContent,
        source_url: issue.url,
        shape: 'work_item' as const,
        metadata: {
          provider: 'github',
          resource_type: 'issue',
          created_at: issue.createdAt,
          owner,
          repo
        }
      };
      
      chunks.push(chunk);
    }

    hasNextPage = issuesResult.pageInfo.hasNextPage;
    cursor = issuesResult.pageInfo.endCursor;
  }

  return chunks;
}
