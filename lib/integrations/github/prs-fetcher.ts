import { githubFetch } from './client';
import { FetchedChunk, StructuredOwner } from '../base';
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
          state
          mergedAt
          author {
            login
          }
          assignees(first: 10) {
            nodes {
              login
            }
          }
          reviews(first: 50) {
            nodes {
              body
              author {
                login
              }
            }
          }
          reviewThreads(first: 20) {
            nodes {
              comments(first: 10) {
                nodes {
                  body
                  author {
                    login
                  }
                }
              }
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
      // Review summaries (top-level review bodies)
      const allReviews = (pr.reviews?.nodes ?? [])
        .map((r: any) => r.body)
        .filter(Boolean)
        .join('\n---\n')

      // Inline review thread comments
      const allThreadComments = (pr.reviewThreads?.nodes ?? [])
        .flatMap((thread: any) => (thread.comments?.nodes ?? []).map((c: any) => c.body))
        .filter(Boolean)
        .join('\n---\n')

      const lines = [`Pull Request: ${pr.title}`, '', pr.body]
      if (allReviews) lines.push('', 'Reviews:', allReviews)
      if (allThreadComments) lines.push('', 'Review Comments:', allThreadComments)
      const fullContent = lines.filter((l) => l != null).join('\n')

      // REFOCUS §5.3: "Closes #N" references
      const structuredLinks: StructuredLink[] = (pr.closingIssuesReferences?.nodes ?? [])
        .filter((issue: any) => issue?.number)
        .map((issue: any) => ({
          relation: 'RESOLVES' as const,
          target_label: `#${issue.number}: ${issue.title ?? ''}`.trim(),
          target_entity_type: 'ticket',
        }));

      // Structured owners: author and assignees
      const structuredOwners: StructuredOwner[] = []
      if (pr.author?.login) {
        structuredOwners.push({ person_label: pr.author.login, provider_account_id: pr.author.login, relation: 'OWNS' })
      }
      for (const assignee of pr.assignees?.nodes ?? []) {
        if (assignee.login) {
          structuredOwners.push({ person_label: assignee.login, provider_account_id: assignee.login, relation: 'WORKS_ON' })
        }
      }

      const chunk: FetchedChunk = {
        chunk_id: pr.id,
        title: pr.title,
        content: fullContent,
        source_url: pr.url,
        shape: 'work_item' as const,
        ...(structuredOwners.length > 0 ? { structured_owners: structuredOwners } : {}),
        metadata: {
          provider: 'github',
          resource_type: 'pull_request',
          created_at: pr.createdAt,
          state: pr.state,
          merged_at: pr.mergedAt ?? null,
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
