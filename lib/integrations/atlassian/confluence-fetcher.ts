import { getAtlassianResources, atlassianFetch } from "./client";
import { stripHtml } from "./confluence-html";
import type { FetchedChunk } from "../base";
import { assertSafeMetadata } from "../base";
import { type SyncConfig, getSelectedResourceIds } from "../sync-config";

/**
 * Fetches Confluence pages for the given connection and org.
 * Paginates through all results using cursor-based pagination.
 */
export async function fetchConfluencePages(
  connectionId: string,
  orgId: string,
  options?: { since?: string; limit?: number; syncConfig?: SyncConfig }
): Promise<FetchedChunk[]> {
  const resources = await getAtlassianResources(connectionId, "confluence", orgId);
  if (!resources || resources.length === 0) {
    throw new Error("Atlassian API: No accessible Confluence resources found");
  }

  const cloudId = resources[0].id;
  const cloudUrl = resources[0].url; // e.g. https://athene-ai.atlassian.net/wiki

  // Build optional space-id filter query params.
  // browseConfluence stores the numeric space ID as the resource ID.
  const selectedSpaceIds = options?.syncConfig
    ? getSelectedResourceIds(options.syncConfig)
    : null
  const spaceFilter = selectedSpaceIds && selectedSpaceIds.size > 0
    ? Array.from(selectedSpaceIds).map(id => `&space-id=${encodeURIComponent(id)}`).join('')
    : ''

  const chunks: FetchedChunk[] = [];
  const limit = options?.limit ?? 50;
  let cursor: string | null = null;

  do {
    const cursorParam: string = cursor
      ? `&cursor=${encodeURIComponent(cursor)}`
      : "";
    const data = await atlassianFetch<{
      results: any[];
      _links?: { next?: string };
    }>(
      connectionId,
      cloudId,
      `/wiki/api/v2/pages?limit=${limit}&body-format=storage${spaceFilter}${cursorParam}`,
      orgId,
      "confluence"
    );

    if (!data.results?.length) break;

    for (const page of data.results) {
      const bodyHtml = page.body?.storage?.value ?? "";
      const content = stripHtml(bodyHtml);

      // Ensure cloudUrl has /wiki if it's missing (though it usually is present)
      const wikiBase = cloudUrl.endsWith("/wiki") ? cloudUrl : `${cloudUrl}/wiki`;

      const chunk: FetchedChunk = {
        chunk_id: `confluence_${page.id}`,
        title: `Confluence: ${page.title}`,
        content: content || page.title,
        source_url: page._links?.webui
          ? `${wikiBase}${page._links.webui}`
          : `${wikiBase}/spaces/${page.spaceId}/pages/${page.id}`,
        metadata: {
          provider: "confluence",
          resource_type: "page",
          space_id: page.spaceId,
          last_modified: page.version?.createdAt,
        },
      };

      assertSafeMetadata(chunk.metadata);
      chunks.push(chunk);
    }

    const nextLink = data._links?.next;
    cursor = nextLink
      ? new URL(nextLink, "https://api.atlassian.com").searchParams.get("cursor")
      : null;
  } while (cursor);

  return chunks;
}

/**
 * Real-time search for Confluence pages (Mode B).
 */
export async function searchConfluencePages(
  connectionId: string,
  query: string,
  orgId: string,
  limit: number = 10
): Promise<FetchedChunk[]> {
  const resources = await getAtlassianResources(
    connectionId,
    "confluence",
    orgId
  );
  if (!resources || resources.length === 0) {
    throw new Error("Atlassian API: No accessible Confluence resources found");
  }

  const cloudId = resources[0].id;
  const cloudUrl = resources[0].url;

  const data = await atlassianFetch<{ results: any[] }>(
    connectionId,
    cloudId,
    `/wiki/api/v2/pages?title=${encodeURIComponent(query)}&limit=${limit}`,
    orgId,
    "confluence"
  );

  const wikiBase = cloudUrl.endsWith("/wiki") ? cloudUrl : `${cloudUrl}/wiki`;

  const chunks: FetchedChunk[] = (data.results ?? []).map((page) => {
    return {
      chunk_id: `confluence_${page.id}`,
      title: `Confluence: ${page.title}`,
      content: page.title, // API v2 search results don't always include body by default
      source_url: page._links?.webui
        ? `${wikiBase}${page._links.webui}`
        : `${wikiBase}/spaces/${page.spaceId}/pages/${page.id}`,
      metadata: {
        provider: "confluence",
        resource_type: "page",
        space_id: page.spaceId,
        last_modified: page.version?.createdAt,
      },
    };
  });

  chunks.forEach((c) => assertSafeMetadata(c.metadata));
  return chunks;
}
