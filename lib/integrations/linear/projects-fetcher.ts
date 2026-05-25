import { linearFetch } from './client';
import { FetchedChunk } from '../base';
import { type SyncConfig, getSelectedResourceIds } from '../sync-config';

const PROJECTS_QUERY = `
  query GetProjects($cursor: String) {
    projects(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        description
        url
        state
        startDate
        targetDate
        completedAt
        createdAt
        updatedAt
        lead {
          name
        }
        members {
          nodes {
            name
          }
        }
        projectUpdates(first: 5) {
          nodes {
            body
            createdAt
          }
        }
      }
    }
  }
`

const PROJECTS_QUERY_FILTERED = `
  query GetProjectsFiltered($cursor: String, $teamIds: [ID!]!) {
    projects(first: 50, after: $cursor, filter: { teams: { some: { id: { in: $teamIds } } } }) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        description
        url
        state
        startDate
        targetDate
        completedAt
        createdAt
        updatedAt
        lead {
          name
        }
        members {
          nodes {
            name
          }
        }
        projectUpdates(first: 5) {
          nodes {
            body
            createdAt
          }
        }
      }
    }
  }
`

// Note: Milestones usually reside either globally or within project structure depending on schema version.
// Here we fetch project with recent updates as part of projects sync. You can incorporate milestones separately.

export async function linearProjectsFetcher(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig,
): Promise<FetchedChunk[]> {
  const selectedTeamIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const teamIds = selectedTeamIds && selectedTeamIds.size > 0 ? Array.from(selectedTeamIds) : null

  const query = teamIds ? PROJECTS_QUERY_FILTERED : PROJECTS_QUERY

  const chunks: FetchedChunk[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const variables: Record<string, unknown> = { cursor }
    if (teamIds) variables.teamIds = teamIds

    const data: any = await linearFetch(connectionId, orgId, query, variables);

    const projectsResult = data.data?.projects;
    if (!projectsResult) break;

    for (const project of projectsResult.nodes) {
      const lead    = project.lead?.name
      const members = (project.members?.nodes ?? []).map((m: any) => m.name).filter(Boolean)
      const updates = (project.projectUpdates?.nodes ?? [])
        .map((u: any) => u.body)
        .filter(Boolean)
        .join('\n---\n')

      const lines: string[] = [`Project: ${project.name}`]
      if (project.state) lines.push(`State: ${project.state}`)
      if (lead)          lines.push(`Lead: ${lead}`)
      if (members.length) lines.push(`Members: ${members.join(', ')}`)
      if (project.startDate) lines.push(`Start: ${project.startDate}`)
      if (project.targetDate) lines.push(`Target: ${project.targetDate}`)
      if (project.description) lines.push('', project.description)
      if (updates) lines.push('', 'Updates:', updates)

      chunks.push({
        chunk_id: project.id,
        title: project.name,
        content: lines.join('\n'),
        source_url: project.url,
        metadata: {
          provider:      'linear',
          resource_type: 'project',
          created_at:    project.createdAt,
          last_modified: project.updatedAt,
          state:         project.state ?? null,
          lead:          lead ?? null,
        },
      })
    }

    hasNextPage = projectsResult.pageInfo.hasNextPage;
    cursor = projectsResult.pageInfo.endCursor;
  }

  return chunks;
}
