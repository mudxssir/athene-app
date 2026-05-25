import { linearFetch } from './client';
import { FetchedChunk } from '../base';
import { type SyncConfig, getSelectedResourceIds } from '../sync-config';

const CYCLES_QUERY = `
  query GetCycles($cursor: String) {
    cycles(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        description
        startsAt
        endsAt
        issues(first: 100) {
          nodes {
            title
            state {
              name
            }
          }
        }
      }
    }
  }
`;

const CYCLES_QUERY_FILTERED = `
  query GetCyclesFiltered($cursor: String, $teamIds: [ID!]!) {
    cycles(first: 50, after: $cursor, filter: { team: { id: { in: $teamIds } } }) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        description
        startsAt
        endsAt
        issues(first: 100) {
          nodes {
            title
            state {
              name
            }
          }
        }
      }
    }
  }
`;

export async function linearCyclesFetcher(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig,
): Promise<FetchedChunk[]> {
  const selectedTeamIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const teamIds = selectedTeamIds && selectedTeamIds.size > 0 ? Array.from(selectedTeamIds) : null

  const query = teamIds ? CYCLES_QUERY_FILTERED : CYCLES_QUERY

  const chunks: FetchedChunk[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const variables: Record<string, unknown> = { cursor }
    if (teamIds) variables.teamIds = teamIds

    const data: any = await linearFetch(connectionId, orgId, query, variables);

    const cyclesResult = data.data?.cycles;
    if (!cyclesResult) break;

    for (const cycle of cyclesResult.nodes) {
      const issuesSummary = cycle.issues?.nodes?.map((i: any) => `- [${i.state?.name || 'Unknown'}] ${i.title}`).join('\n') || '';
      const fullContent = `Linear Cycle: ${cycle.name}\nDates: ${cycle.startsAt} to ${cycle.endsAt}\n\n${cycle.description || ''}\n\nIssues in Cycle:\n${issuesSummary}`;

      const chunk: FetchedChunk = {
        chunk_id: cycle.id,
        title: cycle.name,
        content: fullContent,
        source_url: `https://linear.app/cycle/${cycle.id}`,
        metadata: {
          provider: 'linear',
          resource_type: 'cycle',
        }
      };

      chunks.push(chunk);
    }

    hasNextPage = cyclesResult.pageInfo.hasNextPage;
    cursor = cyclesResult.pageInfo.endCursor;
  }

  return chunks;
}
