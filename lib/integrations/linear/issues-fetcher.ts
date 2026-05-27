import { linearFetch } from './client'
import { FetchedChunk } from '../base'
import { type SyncConfig, getSelectedResourceIds } from '../sync-config'

// Query without team filter — used when all teams are synced.
const ISSUES_QUERY = `
  query GetIssues($cursor: String) {
    issues(first: 25, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        url
        priority
        createdAt
        updatedAt
        state {
          name
          type
        }
        assignee {
          name
        }
        team {
          name
          key
        }
        labels {
          nodes {
            name
          }
        }
        comments(first: 5) {
          nodes {
            body
            createdAt
          }
        }
      }
    }
  }
`

const PRIORITY_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
}

// Query with team filter — used when specific teams are selected.
// Linear GraphQL supports `filter: { team: { id: { in: $teamIds } } }`.
const ISSUES_QUERY_FILTERED = `
  query GetIssuesFiltered($cursor: String, $teamIds: [ID!]!) {
    issues(first: 25, after: $cursor, filter: { team: { id: { in: $teamIds } } }) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        identifier
        title
        description
        url
        priority
        createdAt
        updatedAt
        state {
          name
          type
        }
        assignee {
          name
        }
        team {
          name
          key
        }
        labels {
          nodes {
            name
          }
        }
        comments(first: 5) {
          nodes {
            body
            createdAt
          }
        }
      }
    }
  }
`

export async function linearIssuesFetcher(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []
  let hasNextPage = true
  let cursor: string | null = null

  // browseLinear stores team UUIDs as resource IDs.
  const selectedTeamIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const teamIds = selectedTeamIds && selectedTeamIds.size > 0
    ? Array.from(selectedTeamIds)
    : null

  const query = teamIds ? ISSUES_QUERY_FILTERED : ISSUES_QUERY
  const baseVars = teamIds ? { teamIds } : {}

  while (hasNextPage) {
    const data: any = await linearFetch(connectionId, orgId, query, { cursor, ...baseVars })

    const issuesResult = data.data?.issues
    if (!issuesResult) break

    for (const issue of issuesResult.nodes) {
      const state    = issue.state?.name ?? 'Unknown'
      const priority = PRIORITY_LABELS[issue.priority as number] ?? 'Unknown'
      const assignee = issue.assignee?.name
      const team     = issue.team?.name
      const labels   = (issue.labels?.nodes ?? []).map((l: any) => l.name).join(', ')
      const comments = (issue.comments?.nodes ?? [])
        .map((c: any) => c.body)
        .filter(Boolean)
        .join('\n---\n')

      const lines: string[] = [
        `Issue ${issue.identifier}: ${issue.title}`,
        `Status: ${state}`,
        `Priority: ${priority}`,
      ]
      if (team)     lines.push(`Team: ${team}`)
      if (assignee) lines.push(`Assignee: ${assignee}`)
      if (labels)   lines.push(`Labels: ${labels}`)
      if (issue.description) lines.push('', issue.description)
      if (comments) lines.push('', 'Comments:', comments)

      chunks.push({
        chunk_id: issue.id,
        title: `${issue.identifier}: ${issue.title}`,
        content: lines.join('\n'),
        source_url: issue.url,
        metadata: {
          provider: 'linear',
          resource_type: 'issue',
          created_at: issue.createdAt,
          last_modified: issue.updatedAt,
          state,
          priority,
          team: team ?? null,
          assignee: assignee ?? null,
        },
      })
    }

    hasNextPage = issuesResult.pageInfo.hasNextPage
    cursor = issuesResult.pageInfo.endCursor
  }

  return chunks
}
