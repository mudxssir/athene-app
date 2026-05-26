import { getAtlassianResources, atlassianFetch } from "./client";
import { extractTextFromADF } from "./adf-to-text";
import type { FetchedChunk } from "../base";
import { assertSafeMetadata } from "../base";
import { type SyncConfig, getSelectedResourceIds } from "../sync-config";

/**
 * Fetches Jira issues for the given connection and org.
 * Paginates through all results using startAt/maxResults.
 */
export async function fetchJiraIssues(
  connectionId: string,
  orgId: string,
  options?: { since?: string; limit?: number; syncConfig?: SyncConfig }
): Promise<FetchedChunk[]> {
  const resources = await getAtlassianResources(connectionId, "jira", orgId);
  if (!resources || resources.length === 0) {
    throw new Error("Atlassian API: No accessible Jira resources found");
  }

  const cloudId = resources[0].id;
  const cloudUrl = resources[0].url; // e.g. https://athene-ai.atlassian.net

  const chunks: FetchedChunk[] = [];
  const maxResults = options?.limit ?? 50;
  let startAt = 0;
  let total = Infinity;

  // browseJira stores the project key (e.g. "PROJ") as the resource ID.
  const selectedProjectKeys = options?.syncConfig
    ? getSelectedResourceIds(options.syncConfig)
    : null

  // Build JQL: scope to selected projects if any, and optional since filter.
  const projectClause = selectedProjectKeys && selectedProjectKeys.size > 0
    ? `project IN (${Array.from(selectedProjectKeys).map(k => `"${k}"`).join(',')})`
    : null
  const sinceClause = options?.since ? `updated >= "${options.since}"` : null
  const whereClauses = [projectClause, sinceClause].filter(Boolean).join(' AND ')
  const jql = whereClauses ? `${whereClauses} ORDER BY updated DESC` : 'ORDER BY updated DESC';

  while (startAt < total) {
    const data = await atlassianFetch<{
      issues: any[];
      total: number;
      startAt: number;
    }>(
      connectionId,
      cloudId,
      `/rest/api/3/search?jql=${encodeURIComponent(
        jql
      )}&startAt=${startAt}&maxResults=${maxResults}&fields=summary,description,status,assignee,reporter,created,updated,priority,sprint,comment`,
      orgId,
      "jira"
    );

    total = data.total;
    if (!data.issues?.length) break;

    for (const issue of data.issues) {
      const description = extractTextFromADF(issue.fields.description);
      const priority = issue.fields.priority?.name
      const sprint   = issue.fields.sprint?.name ?? issue.fields.sprint?.displayName
      const lines: string[] = [
        `Summary: ${issue.fields.summary}`,
        `Status: ${issue.fields.status?.name ?? 'Unknown'}`,
        `Assignee: ${issue.fields.assignee?.displayName ?? 'Unassigned'}`,
        `Reporter: ${issue.fields.reporter?.displayName ?? 'Unknown'}`,
      ]
      if (priority) lines.push(`Priority: ${priority}`)
      if (sprint)   lines.push(`Sprint: ${sprint}`)
      if (description) lines.push('', description)

      // Inline comments — expanded via field=comment at zero extra API cost
      // Cap at 10 most-recent to prevent runaway chunk size on high-traffic issues
      const allComments: any[] = issue.fields.comment?.comments ?? []
      const comments = allComments.slice(-10)
      if (comments.length > 0) {
        const commentLines = comments.map((c: any) => {
          const author = c.author?.displayName ?? 'Unknown'
          const text = extractTextFromADF(c.body)
          return `${author}: ${text}`
        }).join('\n---\n')
        lines.push('', 'Comments:', commentLines)
      }

      const chunk: FetchedChunk = {
        chunk_id: `jira_${issue.id}`,
        title: `[${issue.key}] ${issue.fields.summary}`,
        content: lines.join('\n'),
        source_url: `${cloudUrl}/browse/${issue.key}`,
        metadata: {
          provider: "jira",
          resource_type: "issue",
          issue_key: issue.key,
          status: issue.fields.status?.name,
          priority: priority ?? null,
          last_modified: issue.fields.updated,
        },
      };

      assertSafeMetadata(chunk.metadata);
      chunks.push(chunk);
    }

    startAt += data.issues.length;
    if (startAt >= total) break;
  }

  return chunks;
}

/**
 * Real-time JQL search for LangGraph retrieval-agent use (Mode B).
 * Returns raw Jira API response — not indexed, ephemeral.
 */
export async function searchJiraIssues(
  connectionId: string,
  jql: string,
  orgId: string,
  limit: number = 10
): Promise<FetchedChunk[]> {
  const resources = await getAtlassianResources(connectionId, "jira", orgId);
  if (!resources || resources.length === 0) {
    throw new Error("Atlassian API: No accessible Jira resources found");
  }

  const cloudId = resources[0].id;
  const cloudUrl = resources[0].url;

  const data = await atlassianFetch<{ issues: any[] }>(
    connectionId,
    cloudId,
    `/rest/api/3/search?jql=${encodeURIComponent(
      jql
    )}&maxResults=${limit}&fields=summary,description,status,assignee,updated`,
    orgId,
    "jira"
  );

  const chunks: FetchedChunk[] = (data.issues ?? []).map((issue) => {
    const description = extractTextFromADF(issue.fields.description);
    return {
      chunk_id: `jira_${issue.id}`,
      title: `[${issue.key}] ${issue.fields.summary}`,
      content: `Summary: ${issue.fields.summary}\nStatus: ${
        issue.fields.status?.name
      }\nAssignee: ${
        issue.fields.assignee?.displayName ?? "Unassigned"
      }\n\n${description}`,
      source_url: `${cloudUrl}/browse/${issue.key}`,
      metadata: {
        provider: "jira",
        resource_type: "issue",
        issue_key: issue.key,
        status: issue.fields.status?.name,
        last_modified: issue.fields.updated,
      },
    };
  });

  chunks.forEach((c) => assertSafeMetadata(c.metadata));
  return chunks;
}
