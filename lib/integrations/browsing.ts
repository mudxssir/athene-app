// ============================================================
// integrations/browsing.ts — Resource discovery for selective sync
//
// Provides a ProviderBrowser interface and per-provider
// implementations that list browsable resources (folders,
// channels, repos, etc.) without fetching any content.
//
// Used by GET /api/connections/[id]/browse to let the
// frontend present a tree picker before syncing.
//
// Security:
//   • All API calls go through the provider-specific client
//     (googleFetch, slackFetch, etc.) which handles OAuth tokens
//   • No content is fetched — metadata only
//   • orgId is always passed for ownership verification
// ============================================================

import { googleFetch } from './google/api-client'
import { slackFetch } from './slack/client'
import { notionFetch } from './notion/client'
import { githubRestFetch } from './github/client'
import { listSnowflakeTables } from './snowflake/schema-fetcher'
import { listBigQueryTables } from './bigquery/client'
import { listRedshiftTables } from './redshift/client'
import { browsePowerBI } from './powerbi/browser'
import { graphFetch } from './microsoft/graph-client'
import { getCloudId, jiraFetch, confluenceFetch } from './atlassian/client'
import { linearFetch } from './linear/client'
import { lookerFetch } from './looker/client'
import { tableauSignIn, tableauFetch } from './tableau/client'
import { metabaseFetch } from './metabase/client'
import { dbtFetch, dbtAccountId } from './dbt/client'
import type { ProviderKey } from './providers'
import { BROWSABLE_PROVIDERS } from './providers'

// ---- Types --------------------------------------------------

/**
 * A single browsable resource node in the tree.
 * The frontend renders these as expandable tree items with checkboxes.
 */
export interface BrowsableResource {
  /** Provider-specific ID (folder ID, channel ID, repo full_name, etc.) */
  id: string
  /** Human-readable display name */
  name: string
  /** Resource kind — determines icon and behavior in the UI */
  type: 'folder' | 'file' | 'channel' | 'repo' | 'database' | 'page' | 'space' | 'project' | 'object_type'
  /** True if this node can be expanded to show children */
  hasChildren: boolean
  /** Breadcrumb path for display (e.g. "My Drive / Engineering / Docs") */
  path: string
  /** Provider-specific metadata for display (icon, count, last modified, etc.) */
  metadata?: Record<string, unknown>
}

/**
 * Result of a browse operation. Supports pagination.
 */
export interface BrowseResult {
  resources: BrowsableResource[]
  /** Pagination token for the next page, if there is one */
  nextPageToken?: string
}

/**
 * Signature for a provider's browse function.
 *
 * @param connectionId - Nango connection ID
 * @param orgId        - Organization ID for ownership verification
 * @param parentId     - ID of the parent to list children of (null = root)
 * @param options      - Pagination options
 */
export type ProviderBrowser = (
  connectionId: string,
  orgId: string,
  parentId?: string | null,
  options?: {
    pageToken?: string
    limit?: number
    /** Breadcrumb path of the parent node, used to build full paths for children. */
    parentPath?: string
  }
) => Promise<BrowseResult>

// ---- Provider Implementations --------------------------------

/**
 * Google Drive browser — lists folders and files.
 * At root level, lists folders first.
 * When parentId is provided, lists children of that folder.
 */
async function browseDrive(
  connectionId: string,
  orgId: string,
  parentId?: string | null,
  options?: { pageToken?: string; limit?: number; parentPath?: string }
): Promise<BrowseResult> {
  const parent = parentId ?? 'root'
  const pageSize = Math.min(options?.limit ?? 50, 100)

  const q = `'${parent}' in parents and trashed=false`
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,webViewLink,modifiedTime,owners),nextPageToken',
    pageSize: String(pageSize),
    orderBy: 'folder,name',
  })
  if (options?.pageToken) params.set('pageToken', options.pageToken)

  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`
  const listing = await googleFetch<{
    files: Array<{
      id: string
      name: string
      mimeType: string
      webViewLink?: string
      modifiedTime?: string
      owners?: Array<{ displayName: string }>
    }>
    nextPageToken?: string
  }>(connectionId, orgId, url)

  const parentPath = options?.parentPath ?? ''
  const resources: BrowsableResource[] = listing.files.map((file) => {
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder'
    return {
      id: file.id,
      name: file.name,
      type: isFolder ? 'folder' as const : 'file' as const,
      hasChildren: isFolder,
      path: `${parentPath}/${file.name}`,
      metadata: {
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        owner: file.owners?.[0]?.displayName,
        webViewLink: file.webViewLink,
      },
    }
  })

  return {
    resources,
    nextPageToken: listing.nextPageToken,
  }
}

/**
 * Slack browser — lists public channels.
 * Slack has a flat structure, so parentId is ignored.
 */
async function browseSlack(
  connectionId: string,
  orgId: string,
  _parentId?: string | null,
  options?: { pageToken?: string; limit?: number }
): Promise<BrowseResult> {
  const params: Record<string, string> = {
    exclude_archived: 'true',
    types: 'public_channel',
    limit: String(Math.min(options?.limit ?? 100, 200)),
  }
  if (options?.pageToken) params.cursor = options.pageToken

  const res = await slackFetch<{
    channels: Array<{
      id: string
      name: string
      num_members?: number
      topic?: { value: string }
      purpose?: { value: string }
    }>
    response_metadata?: { next_cursor?: string }
  }>(connectionId, orgId, 'conversations.list', params)

  const resources: BrowsableResource[] = res.channels
    .filter((ch: any) => !ch.is_archived)
    .map((ch) => ({
      id: ch.id,
      name: `#${ch.name}`,
      type: 'channel' as const,
      hasChildren: false,
      path: `/#${ch.name}`,
      metadata: {
        memberCount: ch.num_members,
        topic: ch.topic?.value,
        purpose: ch.purpose?.value,
      },
    }))

  return {
    resources,
    nextPageToken: res.response_metadata?.next_cursor || undefined,
  }
}

/**
 * Notion browser — lists pages and databases at the workspace root.
 * Notion's API uses search, so parentId is used as a filter hint.
 */
async function browseNotion(
  connectionId: string,
  orgId: string,
  parentId?: string | null,
  options?: { pageToken?: string; limit?: number }
): Promise<BrowseResult> {
  // When drilling into a page, list its children via /blocks/{id}/children
  if (parentId) {
    const res = await notionFetch(connectionId, orgId, `/blocks/${parentId}/children`, {
      page_size: Math.min(options?.limit ?? 50, 100),
      ...(options?.pageToken ? { start_cursor: options.pageToken } : {}),
    })
    const resources: BrowsableResource[] = []
    for (const block of res.results ?? []) {
      if (block.type === 'child_page') {
        const title = block.child_page?.title || 'Untitled Page'
        resources.push({
          id: block.id,
          name: title,
          type: 'page',
          hasChildren: block.has_children === true,
          path: `/${title}`,
          metadata: { url: `https://notion.so/${block.id.replace(/-/g, '')}` },
        })
      } else if (block.type === 'child_database') {
        const title = block.child_database?.title || 'Untitled Database'
        resources.push({
          id: block.id,
          name: title,
          type: 'database',
          hasChildren: true,
          path: `/${title}`,
          metadata: { url: `https://notion.so/${block.id.replace(/-/g, '')}` },
        })
      }
    }
    return {
      resources,
      nextPageToken: res.has_more ? res.next_cursor : undefined,
    }
  }

  const searchBody: Record<string, unknown> = {
    page_size: Math.min(options?.limit ?? 50, 100),
  }
  if (options?.pageToken) searchBody.start_cursor = options.pageToken

  const res = await notionFetch(connectionId, orgId, '/search', searchBody)

  const resources: BrowsableResource[] = []

  for (const item of res.results ?? []) {
    if (item.object === 'database') {
      const title = item.title?.map((t: any) => t.plain_text).join('') || 'Untitled Database'
      resources.push({
        id: item.id,
        name: title,
        type: 'database',
        hasChildren: true,
        path: `/${title}`,
        metadata: {
          lastEdited: item.last_edited_time,
          url: item.url,
        },
      })
    } else if (item.object === 'page') {
      const props = item.properties ?? {}
      const titleProp = Object.values(props).find((p: any) => p.type === 'title') as any
      const title = titleProp?.title?.map((t: any) => t.plain_text).join('') || 'Untitled Page'
      resources.push({
        id: item.id,
        name: title,
        type: 'page',
        hasChildren: item.has_children === true,
        path: `/${title}`,
        metadata: {
          lastEdited: item.last_edited_time,
          url: item.url,
        },
      })
    }
  }

  return {
    resources,
    nextPageToken: res.has_more ? res.next_cursor : undefined,
  }
}

/**
 * GitHub browser — lists repos for the authenticated user.
 * parentId is not used at root level.
 */
async function browseGitHub(
  connectionId: string,
  orgId: string,
  _parentId?: string | null,
  options?: { pageToken?: string; limit?: number }
): Promise<BrowseResult> {
  const perPage = Math.min(options?.limit ?? 30, 100)
  const page = options?.pageToken ? parseInt(options.pageToken, 10) : 1

  const repos = await githubRestFetch(
    connectionId,
    orgId,
    `/user/repos?per_page=${perPage}&page=${page}&sort=updated&type=all`
  ) as Array<{
    full_name: string
    name: string
    description?: string
    html_url: string
    language?: string
    updated_at: string
    default_branch: string
    private: boolean
    has_wiki: boolean
    has_issues: boolean
  }>

  const resources: BrowsableResource[] = repos.map((repo) => ({
    id: repo.full_name,
    name: repo.name,
    type: 'repo' as const,
    hasChildren: false,
    path: `/${repo.full_name}`,
    metadata: {
      description: repo.description,
      language: repo.language,
      updatedAt: repo.updated_at,
      htmlUrl: repo.html_url,
      isPrivate: repo.private,
      hasWiki: repo.has_wiki,
      hasIssues: repo.has_issues,
    },
  }))

  // GitHub uses page-based pagination — encode next page number as token
  const hasMore = repos.length === perPage
  return {
    resources,
    nextPageToken: hasMore ? String(page + 1) : undefined,
  }
}

/**
 * Snowflake browser — lists available tables.
 */
async function browseSnowflake(
  connectionId: string,
  orgId: string
): Promise<BrowseResult> {
  const tables = await listSnowflakeTables(connectionId, orgId)
  return {
    resources: tables.map((t) => ({
      id: t.fullName,
      name: t.fullName,
      type: 'database' as const,
      hasChildren: false,
      path: `/${t.fullName}`,
    })),
  }
}

/**
 * BigQuery browser — lists available tables.
 */
async function browseBigQuery(
  connectionId: string,
  orgId: string
): Promise<BrowseResult> {
  const tables = await listBigQueryTables(connectionId, orgId)
  return {
    resources: tables.map((t) => ({
      id: t.fullName,
      name: t.fullName,
      type: 'database' as const,
      hasChildren: false,
      path: `/${t.fullName}`,
    })),
  }
}

/**
 * Redshift browser — lists available tables.
 */
async function browseRedshift(
  connectionId: string,
  orgId: string
): Promise<BrowseResult> {
  const tables = await listRedshiftTables(connectionId, orgId)
  return {
    resources: tables.map((t) => ({
      id: t.fullName,
      name: t.fullName,
      type: 'database' as const,
      hasChildren: false,
      path: `/${t.fullName}`,
    })),
  }
}

// ---- Group A: Google flat-list providers ---------------------

async function browseGmail(
  connectionId: string,
  orgId: string
): Promise<BrowseResult> {
  const res = await googleFetch<{ labels: Array<{ id: string; name: string; type: string }> }>(
    connectionId,
    orgId,
    'https://www.googleapis.com/gmail/v1/users/me/labels'
  )
  const resources: BrowsableResource[] = (res.labels ?? [])
    .filter((l) => !l.name.startsWith('CATEGORY_') && l.type !== 'system')
    .map((l) => ({
      id: l.id,
      name: l.name,
      type: 'folder' as const,
      hasChildren: false,
      path: `/${l.name}`,
    }))
  return { resources }
}

async function browseGoogleCalendar(
  connectionId: string,
  orgId: string
): Promise<BrowseResult> {
  const res = await googleFetch<{ items: Array<{ id: string; summary: string; description?: string; primary?: boolean }> }>(
    connectionId,
    orgId,
    'https://www.googleapis.com/calendar/v3/users/me/calendarList'
  )
  const resources: BrowsableResource[] = (res.items ?? []).map((cal) => ({
    id: cal.id,
    name: cal.summary,
    type: 'folder' as const,
    hasChildren: false,
    path: `/${cal.summary}`,
    metadata: { description: cal.description, primary: cal.primary },
  }))
  return { resources }
}

// ---- Group B: Microsoft providers ----------------------------

async function browseOutlook(
  connectionId: string,
  orgId: string
): Promise<BrowseResult> {
  const res = await graphFetch(
    connectionId,
    orgId,
    '/me/mailFolders?$select=id,displayName,totalItemCount&$top=50'
  )
  const resources: BrowsableResource[] = (res.value ?? []).map((f: any) => ({
    id: f.id,
    name: f.displayName,
    type: 'folder' as const,
    hasChildren: false,
    path: `/${f.displayName}`,
    metadata: { totalItemCount: f.totalItemCount },
  }))
  return { resources }
}

async function browseMsCalendar(
  connectionId: string,
  orgId: string
): Promise<BrowseResult> {
  const res = await graphFetch(connectionId, orgId, '/me/calendars?$select=id,name,canEdit')
  const resources: BrowsableResource[] = (res.value ?? []).map((c: any) => ({
    id: c.id,
    name: c.name,
    type: 'folder' as const,
    hasChildren: false,
    path: `/${c.name}`,
    metadata: { canEdit: c.canEdit },
  }))
  return { resources }
}

async function browseOneDrive(
  connectionId: string,
  orgId: string,
  parentId?: string | null,
  options?: { pageToken?: string; limit?: number; parentPath?: string }
): Promise<BrowseResult> {
  const pageSize = Math.min(options?.limit ?? 50, 100)
  const select = '$select=id,name,folder,file,webUrl,lastModifiedDateTime'
  const endpoint = parentId
    ? `/me/drive/items/${parentId}/children?${select}&$top=${pageSize}`
    : `/me/drive/root/children?${select}&$top=${pageSize}&$orderby=name`

  const fullEndpoint = options?.pageToken
    ? options.pageToken
    : endpoint

  const res = await graphFetch(connectionId, orgId, fullEndpoint)
  const parentPath = options?.parentPath ?? ''
  const resources: BrowsableResource[] = (res.value ?? []).map((item: any) => {
    const isFolder = !!item.folder
    return {
      id: item.id,
      name: item.name,
      type: isFolder ? 'folder' as const : 'file' as const,
      hasChildren: isFolder,
      path: `${parentPath}/${item.name}`,
      metadata: { webUrl: item.webUrl, lastModified: item.lastModifiedDateTime },
    }
  })

  let nextPageToken: string | undefined
  if (res['@odata.nextLink']) {
    const next = new URL(res['@odata.nextLink'])
    nextPageToken = next.pathname.replace('/v1.0', '') + next.search
  }

  return { resources, nextPageToken }
}

async function browseSharePoint(
  connectionId: string,
  orgId: string,
  parentId?: string | null,
  options?: { pageToken?: string; limit?: number; parentPath?: string }
): Promise<BrowseResult> {
  if (!parentId) {
    // Root: list SharePoint sites — paths are absolute at this level
    const res = await graphFetch(
      connectionId,
      orgId,
      '/sites?search=*&$select=id,displayName,webUrl&$top=50'
    )
    const resources: BrowsableResource[] = (res.value ?? []).map((site: any) => ({
      id: `site:${site.id}`,
      name: site.displayName,
      type: 'folder' as const,
      hasChildren: true,
      path: `/${site.displayName}`,
      metadata: { webUrl: site.webUrl },
    }))
    return { resources }
  }

  const parentPath = options?.parentPath ?? ''

  if (parentId.startsWith('site:')) {
    // List document libraries (drives) under a site
    const siteId = parentId.slice('site:'.length)
    const res = await graphFetch(connectionId, orgId, `/sites/${siteId}/drives?$select=id,name,webUrl`)
    const resources: BrowsableResource[] = (res.value ?? []).map((drive: any) => ({
      id: `drive:${drive.id}`,
      name: drive.name,
      type: 'folder' as const,
      hasChildren: true,
      path: `${parentPath}/${drive.name}`,
      metadata: { webUrl: drive.webUrl },
    }))
    return { resources }
  }

  if (parentId.startsWith('drive:')) {
    // List root children of a drive
    const driveId = parentId.slice('drive:'.length)
    const pageSize = Math.min(options?.limit ?? 50, 100)
    const res = await graphFetch(
      connectionId,
      orgId,
      `/drives/${driveId}/root/children?$select=id,name,folder,file,webUrl&$top=${pageSize}`
    )
    const resources: BrowsableResource[] = (res.value ?? []).map((item: any) => {
      const isFolder = !!item.folder
      return {
        // Prefix folder IDs with "item:{driveId}:" so nested drills carry the drive context
        id: isFolder ? `item:${driveId}:${item.id}` : item.id,
        name: item.name,
        type: isFolder ? 'folder' as const : 'file' as const,
        hasChildren: isFolder,
        path: `${parentPath}/${item.name}`,
        metadata: { webUrl: item.webUrl },
      }
    })
    return { resources }
  }

  // Generic SharePoint item children — parentId carries driveId as "item:{driveId}:{itemId}"
  // Must use /drives/{driveId}/items/{itemId}/children, NOT /me/drive (personal OneDrive).
  if (parentId.startsWith('item:')) {
    const [, driveId, itemId] = parentId.split(':')
    const pageSize = Math.min(options?.limit ?? 50, 100)
    const res = await graphFetch(
      connectionId,
      orgId,
      `/drives/${driveId}/items/${itemId}/children?$select=id,name,folder,file,webUrl&$top=${pageSize}`
    )
    const resources: BrowsableResource[] = (res.value ?? []).map((item: any) => {
      const isFolder = !!item.folder
      return {
        id: isFolder ? `item:${driveId}:${item.id}` : item.id,
        name: item.name,
        type: isFolder ? 'folder' as const : 'file' as const,
        hasChildren: isFolder,
        path: `${parentPath}/${item.name}`,
        metadata: { webUrl: item.webUrl },
      }
    })
    return { resources }
  }

  // Fallback: personal OneDrive item (shouldn't reach here from SharePoint)
  return browseOneDrive(connectionId, orgId, parentId, options)
}

// ---- Group C: CRM / PM providers ----------------------------

async function browseHubSpot(
  _connectionId: string,
  _orgId: string
): Promise<BrowseResult> {
  return {
    resources: [
      { id: 'contacts', name: 'Contacts', type: 'object_type', hasChildren: false, path: '/contacts' },
      { id: 'companies', name: 'Companies', type: 'object_type', hasChildren: false, path: '/companies' },
      { id: 'deals', name: 'Deals', type: 'object_type', hasChildren: false, path: '/deals' },
      { id: 'notes', name: 'Notes', type: 'object_type', hasChildren: false, path: '/notes' },
    ],
  }
}

async function browseSalesforce(
  _connectionId: string,
  _orgId: string
): Promise<BrowseResult> {
  return {
    resources: [
      { id: 'accounts', name: 'Accounts', type: 'object_type', hasChildren: false, path: '/accounts' },
      { id: 'cases', name: 'Cases', type: 'object_type', hasChildren: false, path: '/cases' },
      { id: 'opportunities', name: 'Opportunities', type: 'object_type', hasChildren: false, path: '/opportunities' },
    ],
  }
}

async function browseJira(connectionId: string, orgId: string): Promise<BrowseResult> {
  const cloudId = await getCloudId(connectionId, orgId, 'jira')
  const res = await jiraFetch<any[]>(connectionId, orgId, cloudId, '/rest/api/3/project')
  const resources: BrowsableResource[] = (Array.isArray(res) ? res : []).map((p: any) => ({
    id: p.key,
    name: p.name,
    type: 'project' as const,
    hasChildren: false,
    path: `/${p.key}`,
    metadata: { projectType: p.projectTypeKey, avatarUrl: p.avatarUrls?.['48x48'] },
  }))
  return { resources }
}

async function browseConfluence(connectionId: string, orgId: string): Promise<BrowseResult> {
  const cloudId = await getCloudId(connectionId, orgId, 'confluence')
  const res = await confluenceFetch<{ results: any[] }>(
    connectionId,
    orgId,
    cloudId,
    '/wiki/rest/api/space?limit=50&type=global',
    undefined
  )
  const resources: BrowsableResource[] = (res.results ?? []).map((space: any) => ({
    // Use numeric space ID so the fetcher can filter with ?space-id= directly.
    // space.id is the Confluence numeric ID; space.key is the human-readable key.
    id: String(space.id ?? space.key),
    name: space.name,
    type: 'space' as const,
    hasChildren: false,
    path: `/${space.key}`,
    metadata: { type: space.type, key: space.key },
  }))
  return { resources }
}

async function browseLinear(connectionId: string, orgId: string): Promise<BrowseResult> {
  const res = await linearFetch(connectionId, orgId, '{ teams { nodes { id name key } } }') as any
  const teams: any[] = res?.data?.teams?.nodes ?? []
  const resources: BrowsableResource[] = teams.map((team) => ({
    id: team.id,
    name: team.name,
    type: 'project' as const,
    hasChildren: false,
    path: `/${team.key}`,
    metadata: { key: team.key },
  }))
  return { resources }
}

// ---- Group D: BI tools ---------------------------------------

async function browseZendesk(
  _connectionId: string,
  _orgId: string
): Promise<BrowseResult> {
  return {
    resources: [
      { id: 'tickets', name: 'Tickets', type: 'object_type', hasChildren: false, path: '/tickets' },
      { id: 'articles', name: 'Help Center Articles', type: 'object_type', hasChildren: false, path: '/articles' },
    ],
  }
}

async function browseLooker(connectionId: string, orgId: string): Promise<BrowseResult> {
  const [looks, dashboards] = await Promise.all([
    lookerFetch<Array<{ id: number; title: string; folder_name?: string }>>(
      connectionId, orgId, '/looks?fields=id,title,folder_name&limit=200'
    ).catch(() => [] as Array<{ id: number; title: string; folder_name?: string }>),
    lookerFetch<Array<{ id: string; title: string; folder_name?: string }>>(
      connectionId, orgId, '/dashboards?fields=id,title,folder_name&limit=200'
    ).catch(() => [] as Array<{ id: string; title: string; folder_name?: string }>),
  ])

  const resources: BrowsableResource[] = [
    ...(looks ?? []).map((l) => ({
      id: `look:${l.id}`,
      name: l.title,
      type: 'database' as const,
      hasChildren: false,
      path: `/${l.title}`,
      metadata: { kind: 'look', folder: l.folder_name },
    })),
    ...(dashboards ?? []).map((d) => ({
      id: `dashboard:${d.id}`,
      name: d.title,
      type: 'database' as const,
      hasChildren: false,
      path: `/${d.title}`,
      metadata: { kind: 'dashboard', folder: d.folder_name },
    })),
  ]
  return { resources }
}

async function browseTableau(connectionId: string, orgId: string): Promise<BrowseResult> {
  const session = await tableauSignIn(connectionId, orgId)
  const res = await tableauFetch<any>(session, `/sites/${session.siteId}/workbooks?pageSize=100`)
  const workbooks: any[] = res?.workbooks?.workbook ?? []
  const resources: BrowsableResource[] = workbooks.map((wb) => ({
    id: wb.id,
    name: wb.name,
    type: 'database' as const,
    hasChildren: false,
    path: `/${wb.name}`,
    metadata: { project: wb.project?.name },
  }))
  return { resources }
}

async function browseMetabase(connectionId: string, orgId: string): Promise<BrowseResult> {
  const [cards, dashboards] = await Promise.all([
    metabaseFetch<Array<{ id: number; name: string; display: string }>>(
      connectionId, orgId, '/card'
    ).catch(() => [] as Array<{ id: number; name: string; display: string }>),
    metabaseFetch<Array<{ id: number; name: string }>>(
      connectionId, orgId, '/dashboard'
    ).catch(() => [] as Array<{ id: number; name: string }>),
  ])

  const resources: BrowsableResource[] = [
    ...(cards ?? []).map((c) => ({
      id: `card:${c.id}`,
      name: c.name,
      type: 'database' as const,
      hasChildren: false,
      path: `/${c.name}`,
      metadata: { kind: 'question', display: c.display },
    })),
    ...(dashboards ?? []).map((d) => ({
      id: `dashboard:${d.id}`,
      name: d.name,
      type: 'database' as const,
      hasChildren: false,
      path: `/${d.name}`,
      metadata: { kind: 'dashboard' },
    })),
  ]
  return { resources }
}

async function browseDbt(connectionId: string, orgId: string): Promise<BrowseResult> {
  // dbtFetch internally resolves accountId from metadata to build the URL.
  // We also surface it per-job so the fetcher can reference it without re-fetching.
  const [res, accountId] = await Promise.all([
    dbtFetch<{ data?: any[] }>(connectionId, orgId, '/jobs/'),
    dbtAccountId(connectionId, orgId),
  ])
  const jobs: any[] = res?.data ?? []
  const resources: BrowsableResource[] = jobs.map((job: any) => ({
    id: String(job.id),
    name: job.name,
    type: 'database' as const,
    hasChildren: false,
    path: `/${job.name}`,
    metadata: { projectId: job.project_id, environmentId: job.environment_id, accountId },
  }))
  return { resources }
}

// ---- Registry -----------------------------------------------

/**
 * Map of provider keys to their browse function.
 */
const providerBrowserMap: Partial<Record<ProviderKey, ProviderBrowser>> = {
  // Google
  google_drive: browseDrive,
  google: browseDrive,
  gmail: browseGmail,
  google_calendar: browseGoogleCalendar,
  // Slack / Notion / GitHub
  slack: browseSlack,
  notion: browseNotion,
  github: browseGitHub,
  // Microsoft
  outlook: browseOutlook,
  ms_calendar: browseMsCalendar,
  onedrive: browseOneDrive,
  sharepoint: browseSharePoint,
  // CRM / PM
  hubspot: browseHubSpot,
  salesforce: browseSalesforce,
  jira: browseJira,
  confluence: browseConfluence,
  linear: browseLinear,
  // BI tools
  zendesk: browseZendesk,
  looker: browseLooker,
  tableau: browseTableau,
  metabase: browseMetabase,
  dbt: browseDbt,
  // Data warehouse
  snowflake: browseSnowflake,
  bigquery: browseBigQuery,
  redshift: browseRedshift,
  powerbi: browsePowerBI,
}

/**
 * Returns the browse function for a given provider, or null if unsupported.
 */
export function getProviderBrowser(provider: ProviderKey): ProviderBrowser | null {
  return providerBrowserMap[provider] ?? null
}

/**
 * Single source of truth lives in providers.ts (client-safe).
 * Re-exported here so server-side callers only need one import.
 *
 * Dev guard: warn if providerBrowserMap and BROWSABLE_PROVIDERS drift out of sync.
 */
export { isBrowsable } from './providers'

if (process.env.NODE_ENV !== 'production') {
  for (const key of Object.keys(providerBrowserMap) as ProviderKey[]) {
    if (!BROWSABLE_PROVIDERS.has(key)) {
      console.error(
        `[browsing] "${key}" is registered in providerBrowserMap but missing from BROWSABLE_PROVIDERS in providers.ts — add it there.`
      )
    }
  }
  for (const key of BROWSABLE_PROVIDERS) {
    if (!(key in providerBrowserMap)) {
      console.error(
        `[browsing] "${key}" is in BROWSABLE_PROVIDERS but has no browser in providerBrowserMap — add a browse function or remove it.`
      )
    }
  }
}
