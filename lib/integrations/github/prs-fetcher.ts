import { githubFetch } from './client';
import { FetchedChunk } from '../base';
import type { StructuredLink } from '@/lib/knowledge-graph/types';

const PRS_QUERY = `
  query GetPRs($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 50, after: $cursor, states: [OPEN, MERGED, CLOSED]) {
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
          reviews(first: 50) {
            nodes {
              body
            }
          }
          closingIssuesReferences(first: 10) {
            nodes {
              number
              title
            }
          }
        }
      }
    }
  }
`;

export async function githubPrsFetcher(connectionId: string, orgId: string, owner: string, repo: string): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: any = await githubFetch(connectionId, orgId, PRS_QUERY, { owner, repo, cursor });
    
    const prsResult = data.data?.repository?.pullRequests;
    if (!prsResult) break;

    for (const pr of prsResult.nodes) {
      const allReviews = pr.reviews?.nodes?.map((r: any) => r.body).filter(Boolean).join('\n---\n') || '';
      const fullContent = `Pull Request: ${pr.title}\n\n${pr.body}\n\nReviews:\n${allReviews}`;

      // REFOCUS §5.3: "Closes #N" references — structured-links.ts swaps
      // RESOLVES into a RESOLVED_BY edge on the resolved issue.
      const structuredLinks: StructuredLink[] = (pr.closingIssuesReferences?.nodes ?? [])
        .filter((issue: any) => issue?.number)
        .map((issue: any) => ({
          relation: 'RESOLVES' as const,
          target_label: `#${issue.number}: ${issue.title ?? ''}`.trim(),
          target_entity_type: 'ticket',
        }));

      const chunk: FetchedChunk = {
        chunk_id: pr.id,
        title: pr.title,
        content: fullContent,
        source_url: pr.url,
        shape: 'work_item' as const,
        metadata: {
          provider: 'github',
          resource_type: 'pull_request',
          created_at: pr.createdAt,
          owner,
          repo,
          ...(structuredLinks.length > 0 ? { structured_links: structuredLinks } : {})
        }
      };
      
      chunks.push(chunk);
    }

    hasNextPage = prsResult.pageInfo.hasNextPage;
    cursor = prsResult.pageInfo.endCursor;
  }

  return chunks;
}
