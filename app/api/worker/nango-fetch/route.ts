export const dynamic = 'force-dynamic';
export const maxDuration = 300; // integration indexing can take several minutes for large orgs

// ============================================================
// api/worker/nango-fetch/route.ts — Background fetch worker
//
// Called by QStash after dispatchThrottled() publishes a job.
// Flow:
//   1. Verify QStash signature (security)
//   2. Extract { orgId, connectionId, provider } from body
//   3. Look up the correct fetcher from providerFetcherMap
//   4. Call fetcher → get FetchedChunk[]
//   5. Pass each chunk through indexDocuments()
//   6. Enqueue graph-build job
//   7. Call releaseSlot() to free QStash concurrency
//
// Security rules:
//   • QStash signature verification required
//   • Nango token obtained inside fetcher, used once, discarded
//   • No tokens or raw content logged
// ============================================================

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify'
import { releaseSlot, qstash } from '@/lib/qstash/client'
import { indexDocuments } from '@/lib/integrations/indexing'
import { logger } from '@/lib/logger'
import { parseSyncConfig, type SyncConfig } from '@/lib/integrations/sync-config'
import { supabaseAdmin } from '@/lib/supabase/server'
import { parseBody, uuidSchema } from '@/lib/validation'
import { redis } from '@/lib/redis/client'
import { connectionsKey } from '@/app/api/connections/route'

// --- Google ---
import { fetchCalendarChunks } from '@/lib/integrations/google/calendar-fetcher'
import { fetchDriveChunks } from '@/lib/integrations/google/drive-fetcher'
// indexEmailChunks: background indexer — fetches full bodies, chunks at 2000 chars
// searchEmailChunks: live agent search — uses snippets only, never for indexing
import { indexEmailChunks } from '@/lib/integrations/google/gmail-fetcher'

// --- Microsoft ---
import { microsoftFetcher } from '@/lib/integrations/microsoft/index'

// --- Productivity & CRM ---
import { fetchSlackMessages } from '@/lib/integrations/slack/channels-fetcher'
import { fetchAllDatabases } from '@/lib/integrations/notion/databases-fetcher'
import { fetchAllPages } from '@/lib/integrations/notion/pages-fetcher'
import { fetchHubSpotCompanies } from '@/lib/integrations/hubspot/companies-fetcher'
import { fetchHubSpotContacts } from '@/lib/integrations/hubspot/contacts-fetcher'
import { fetchHubSpotDeals } from '@/lib/integrations/hubspot/deals-fetcher'
import { fetchHubSpotNotes } from '@/lib/integrations/hubspot/notes-fetcher'
import { fetchSalesforceAccounts } from '@/lib/integrations/salesforce/accounts-fetcher'
import { fetchSalesforceCases } from '@/lib/integrations/salesforce/cases-fetcher'
import { fetchSalesforceContacts } from '@/lib/integrations/salesforce/contacts-fetcher'
import { fetchSalesforceOpportunities } from '@/lib/integrations/salesforce/opportunities-fetcher'
import { fetchZendeskTickets } from '@/lib/integrations/zendesk/tickets-fetcher'
import { fetchZendeskArticles } from '@/lib/integrations/zendesk/articles-fetcher'

// --- Dev tools ---
import { githubIssuesFetcher } from '@/lib/integrations/github/issues-fetcher'
import { githubPrsFetcher } from '@/lib/integrations/github/prs-fetcher'
import { githubWikiFetcher } from '@/lib/integrations/github/wiki-fetcher'
import { linearIssuesFetcher } from '@/lib/integrations/linear/issues-fetcher'
import { linearCyclesFetcher } from '@/lib/integrations/linear/cycles-fetcher'
import { linearProjectsFetcher } from '@/lib/integrations/linear/projects-fetcher'
import { fetchJiraIssues } from '@/lib/integrations/atlassian/jira-fetcher'
import { fetchConfluencePages } from '@/lib/integrations/atlassian/confluence-fetcher'

// --- Data warehouse & BI ---
import { fetchSnowflakeSamples } from '@/lib/integrations/snowflake/sample-fetcher'
import { fetchBigQueryDatasets } from '@/lib/integrations/bigquery/datasets-fetcher'
import { fetchRedshiftTables } from '@/lib/integrations/redshift/tables-fetcher'
import { fetchLookerContent, fetchLookerExplores } from '@/lib/integrations/looker/looks-fetcher'
import { fetchTableauWorkbooks } from '@/lib/integrations/tableau/workbooks-fetcher'
import { fetchMetabaseContent } from '@/lib/integrations/metabase/cards-fetcher'
import { fetchDbtContent } from '@/lib/integrations/dbt/models-fetcher'
import { fetchPowerBIContent } from '@/lib/integrations/powerbi/reports-fetcher'

import { getProviderMetadata, getProviderToken } from '@/lib/integrations/base'
import type { FetchedChunk } from '@/lib/integrations/base'

// ---- Provider Fetcher Map ---------------------------------------

type FetcherFn = (
  connectionId: string,
  orgId: string,
  options?: { since?: string; limit?: number; syncConfig?: SyncConfig }
) => Promise<FetchedChunk[]>

/**
 * Map of provider keys to their full-sync fetcher functions.
 * Each entry produces FetchedChunk[] that are embedded and indexed.
 * Adding a new connector = one entry here + the fetcher file.
 */
const providerFetcherMap: Record<string, FetcherFn[]> = {
  // ── Google Workspace ─────────────────────────────────────────
  google_drive:     [(cid, oid, opts) => fetchDriveChunks(cid, oid, undefined, opts?.syncConfig)],
  // Use indexEmailChunks (full body, chunked) for background indexing — NOT searchEmailChunks
  gmail:            [(cid, oid, opts) => indexEmailChunks(cid, oid, { limit: opts?.limit ?? 200, syncConfig: opts?.syncConfig })],
  google_calendar:  [(cid, oid, opts) => {
    const now = new Date()
    const future = new Date()
    future.setDate(future.getDate() + 30)
    return fetchCalendarChunks(cid, oid, now, future, opts?.syncConfig)
  }],

  // ── Microsoft 365 ────────────────────────────────────────────
  sharepoint:   [(cid, oid, opts) => microsoftFetcher(cid, oid, opts)],
  onedrive:     [(cid, oid, opts) => microsoftFetcher(cid, oid, opts)],
  outlook:      [(cid, oid, opts) => microsoftFetcher(cid, oid, opts)],
  ms_calendar:  [(cid, oid, opts) => microsoftFetcher(cid, oid, opts)],

  // ── Communication ────────────────────────────────────────────
  slack: [(cid, oid, opts) => fetchSlackMessages(cid, oid, opts?.syncConfig)],

  // ── Productivity ─────────────────────────────────────────────
  notion: [(cid, oid, opts) => fetchAllDatabases(cid, oid, opts?.syncConfig), (cid, oid, opts) => fetchAllPages(cid, oid, opts?.syncConfig)],

  // ── CRM ──────────────────────────────────────────────────────
  hubspot: [
    async (connectionId, orgId, opts) => {
      const selected = opts?.syncConfig ? new Set(opts.syncConfig.selectedResources?.map((r) => r.id) ?? []) : new Set<string>()
      const all = selected.size === 0
      const chunks = await Promise.all([
        all || selected.has('companies') ? fetchHubSpotCompanies(connectionId, orgId) : Promise.resolve([]),
        all || selected.has('contacts') ? fetchHubSpotContacts(connectionId, orgId) : Promise.resolve([]),
        all || selected.has('deals') ? fetchHubSpotDeals(connectionId, orgId) : Promise.resolve([]),
        all || selected.has('notes') ? fetchHubSpotNotes(connectionId, orgId) : Promise.resolve([]),
      ])
      return chunks.flat()
    },
  ],
  salesforce: [
    async (connectionId, orgId, opts) => {
      const metadata = await getProviderMetadata(connectionId, 'salesforce', orgId)
      const instanceUrl = metadata.instance_url
      if (!instanceUrl) throw new Error(`Salesforce instance_url not found for connection ${connectionId}`)
      const selected = opts?.syncConfig ? new Set(opts.syncConfig.selectedResources?.map((r) => r.id) ?? []) : new Set<string>()
      const all = selected.size === 0
      const chunks = await Promise.all([
        all || selected.has('accounts') ? fetchSalesforceAccounts(connectionId, instanceUrl, orgId, { since: opts?.since }) : Promise.resolve([]),
        all || selected.has('cases') ? fetchSalesforceCases(connectionId, instanceUrl, orgId, { since: opts?.since }) : Promise.resolve([]),
        all || selected.has('contacts') ? fetchSalesforceContacts(connectionId, instanceUrl, orgId, { since: opts?.since }) : Promise.resolve([]),
        all || selected.has('opportunities') ? fetchSalesforceOpportunities(connectionId, instanceUrl, orgId, { since: opts?.since }) : Promise.resolve([]),
      ])
      return chunks.flat()
    },
  ],
  zendesk: [
    async (connectionId, orgId, opts) => {
      const metadata = await getProviderMetadata(connectionId, 'zendesk', orgId)
      const subdomain = metadata.subdomain
      if (!subdomain) throw new Error(`Zendesk subdomain not found for connection ${connectionId}`)
      const selected = opts?.syncConfig ? new Set(opts.syncConfig.selectedResources?.map((r) => r.id) ?? []) : new Set<string>()
      const all = selected.size === 0
      const chunks = await Promise.all([
        all || selected.has('tickets') ? fetchZendeskTickets(connectionId, orgId, subdomain) : Promise.resolve([]),
        all || selected.has('articles') ? fetchZendeskArticles(connectionId, orgId, subdomain) : Promise.resolve([]),
      ])
      return chunks.flat()
    },
  ],

  // ── Dev Tools ────────────────────────────────────────────────
  github: [
    async (connectionId, orgId, opts) => {
      const metadata = await getProviderMetadata(connectionId, 'github', orgId)
      // If sync_config has selected repos, iterate them; otherwise fall back to metadata.owner/repo
      const selectedRepos = opts?.syncConfig?.selectedResources?.map((r) => r.id) ?? []
      const repos: Array<{ owner: string; repo: string }> = selectedRepos.length > 0
        ? selectedRepos.map((fullName) => {
            const [owner, repo] = String(fullName).split('/')
            return { owner, repo }
          })
        : metadata.owner && metadata.repo
          ? [{ owner: metadata.owner as string, repo: metadata.repo as string }]
          : []
      if (repos.length === 0) throw new Error(`GitHub: no repos configured for connection ${connectionId}`)
      const allChunks = await Promise.all(
        repos.map(({ owner, repo }) =>
          Promise.all([
            githubIssuesFetcher(connectionId, orgId, owner, repo),
            githubPrsFetcher(connectionId, orgId, owner, repo),
            githubWikiFetcher(connectionId, orgId, owner, repo),
          ]).then((results) => results.flat())
        )
      )
      return allChunks.flat()
    },
  ],
  // Nango's demo GitHub integration key — same fetchers as 'github'.
  // When no repos are explicitly configured, auto-discovers the user's
  // accessible repos via the GitHub REST API (up to 20 most recently updated).
  'github-getting-started': [
    async (connectionId, orgId, opts) => {
      const metadata = await getProviderMetadata(connectionId, 'github-getting-started', orgId)
      const selectedRepos = opts?.syncConfig?.selectedResources?.map((r) => r.id) ?? []

      let repos: Array<{ owner: string; repo: string }>

      if (selectedRepos.length > 0) {
        repos = selectedRepos.map((fullName) => {
          const [owner, repo] = String(fullName).split('/')
          return { owner, repo }
        })
      } else if (metadata.owner && metadata.repo) {
        repos = [{ owner: metadata.owner as string, repo: metadata.repo as string }]
      } else {
        // Auto-discover: use the OAuth token to list repos the user has access to.
        // Capped at 20 most-recently-updated to avoid indexing hundreds of repos.
        const token = await getProviderToken(connectionId, 'github-getting-started', orgId)
        const resp = await fetch(
          'https://api.github.com/user/repos?sort=updated&per_page=20&visibility=all',
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' } },
        )
        if (!resp.ok) throw new Error(`GitHub API repos list error: ${resp.status}`)
        const rawRepos = (await resp.json()) as Array<{ full_name: string }>
        repos = rawRepos.map((r) => {
          const [owner, repo] = r.full_name.split('/')
          return { owner, repo }
        })
        if (repos.length === 0) throw new Error(`GitHub (getting-started): no accessible repos found for connection ${connectionId}`)
        logger.info({ count: repos.length, orgId }, '[github-getting-started] Auto-discovered repos')
      }

      const allChunks = await Promise.all(
        repos.map(({ owner, repo }) =>
          Promise.all([
            githubIssuesFetcher(connectionId, orgId, owner, repo),
            githubPrsFetcher(connectionId, orgId, owner, repo),
            githubWikiFetcher(connectionId, orgId, owner, repo),
          ]).then((results) => results.flat())
        )
      )
      return allChunks.flat()
    },
  ],
  linear: [
    async (connectionId, orgId, opts) => {
      const [issues, cycles, projects] = await Promise.all([
        // Issues support team filtering via syncConfig; cycles/projects are cross-team.
        linearIssuesFetcher(connectionId, orgId, opts?.syncConfig),
        linearCyclesFetcher(connectionId, orgId, opts?.syncConfig),
        linearProjectsFetcher(connectionId, orgId, opts?.syncConfig),
      ])
      return [...issues, ...cycles, ...projects]
    },
  ],
  jira:       [(cid, oid, opts) => fetchJiraIssues(cid, oid, opts)],
  confluence: [(cid, oid, opts) => fetchConfluencePages(cid, oid, opts)],

  // ── Data Warehouse ───────────────────────────────────────────
  snowflake: [fetchSnowflakeSamples],
  bigquery:  [fetchBigQueryDatasets],
  redshift:  [fetchRedshiftTables],

  // ── BI Tools ─────────────────────────────────────────────────
  looker: [
    (cid, oid, opts) => fetchLookerContent(cid, oid, opts?.syncConfig),
    (cid, oid) => fetchLookerExplores(cid, oid),
  ],
  tableau:  [(cid, oid, opts) => fetchTableauWorkbooks(cid, oid, opts?.syncConfig)],
  metabase: [(cid, oid, opts) => fetchMetabaseContent(cid, oid, opts?.syncConfig)],
  dbt:      [(cid, oid, opts) => fetchDbtContent(cid, oid, opts?.syncConfig)],
  powerbi:  [(cid, oid, opts) => fetchPowerBIContent(cid, oid, opts?.syncConfig)],

  // ── Legacy umbrella keys (backwards compatibility) ───────────
  google: [
    (cid, oid, opts) => fetchDriveChunks(cid, oid, undefined, opts?.syncConfig),
    (cid, oid, opts) => indexEmailChunks(cid, oid, { limit: opts?.limit ?? 200, syncConfig: opts?.syncConfig }),
    (cid, oid, opts) => {
      const now = new Date()
      const future = new Date()
      future.setDate(future.getDate() + 30)
      return fetchCalendarChunks(cid, oid, now, future, opts?.syncConfig)
    },
  ],
  microsoft:        [(cid, oid, opts) => microsoftFetcher(cid, oid, opts)],
  'microsoft-graph':[(cid, oid, opts) => microsoftFetcher(cid, oid, opts)],
}

// ---- Request body schema ----------------------------------------

const NangoFetchJobSchema = z.object({
  orgId:              uuidSchema,
  connectionId:       uuidSchema,       // Supabase connections.id UUID — FK for documents
  nangoConnectionId:  z.string().max(255).optional(), // Nango string — for provider API calls
  provider:           z.string().min(1).max(100),
  sourceType:         z.string().min(1).max(100),
  departmentId:       uuidSchema.nullable().optional(),
  since:              z.string().optional(),
  syncConfigOverride: z.record(z.string(), z.unknown()).optional(),
})

type NangoFetchJobBody = z.infer<typeof NangoFetchJobSchema>

// ---- POST handler -----------------------------------------------

export async function POST(request: Request): Promise<Response> {
  const isValid = await verifyQStashSignature(request)
  if (!isValid) return new Response('Invalid QStash signature', { status: 401 })

  // Idempotency: skip duplicate deliveries (QStash retries on 5xx / timeouts)
  const isFirstTime = await checkIdempotency(request)
  if (!isFirstTime) {
    logger.info('[nango-fetch] Skipping duplicate job (idempotency)')
    return NextResponse.json({ status: 'ok', skipped: 'duplicate' })
  }

  let raw: unknown
  try { raw = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsedBody = parseBody(NangoFetchJobSchema, raw)
  if (!parsedBody.success) return parsedBody.response
  const { orgId, connectionId, nangoConnectionId, provider, sourceType, departmentId, since, syncConfigOverride } = parsedBody.data

  // Fetchers need the Nango connection string to call Nango APIs.
  // connectionId is the Supabase UUID used only for indexDocuments (FK).
  const fetcherConnectionId = nangoConnectionId ?? connectionId

  const fetchers = providerFetcherMap[provider]
  if (!fetchers) {
    return NextResponse.json(
      { error: `Unknown provider: ${provider}. Available: ${Object.keys(providerFetcherMap).join(', ')}` },
      { status: 400 }
    )
  }

  let fetchResult: { indexed: number; documentIds: string[]; errors: number } | null = null
  let allChunks: FetchedChunk[] = []
  let workerErr: unknown = null

  // ---- Resolve sync_config: caller override takes precedence over DB value ----
  // syncConfigOverride is set by the delta re-indexer (worker/index) to scope a job to
  // specific external IDs without touching the connection's stored sync config.
  let syncConfig: SyncConfig = (syncConfigOverride as SyncConfig | undefined) ?? { mode: 'all' }
  if (!syncConfigOverride) {
    try {
      const { data: conn } = await supabaseAdmin
        .from('connections')
        .select('sync_config')
        .eq('id', connectionId)
        .single()
      if (conn?.sync_config) {
        syncConfig = parseSyncConfig(conn.sync_config)
      }
    } catch (configErr) {
      logger.warn(
        { connectionId, err: configErr instanceof Error ? configErr.message : String(configErr) },
        '[nango-fetch] Failed to read sync_config — falling back to full sync'
      )
    }
  }

  try {
    for (const fetcher of fetchers) {
      const chunks = await fetcher(fetcherConnectionId, orgId, { since, syncConfig })
      allChunks.push(...chunks)
    }

    // Use 'org_wide' visibility — integration documents are org-scoped by default.
    // Without a department, 'department' visibility makes docs invisible to all users
    // since vector_search filters require either org_wide or dept match.
    const visibility = departmentId ? 'department' : 'org_wide'
    const indexResult = await indexDocuments(allChunks, orgId, connectionId, departmentId ?? null, visibility as any)
    fetchResult = indexResult

    if (indexResult.indexed > 0 && indexResult.documentIds.length > 0) {
      const graphBuildUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/worker/graph-build`
      try {
        await qstash.publishJSON({
          url: graphBuildUrl,
          body: { org_id: orgId, document_ids: indexResult.documentIds, job_type: 'incremental' },
        })
      } catch (gErr) {
        logger.error({ err: gErr instanceof Error ? gErr.message : String(gErr) }, '[nango-fetch] Failed to enqueue graph-build')
      }
    }
  } catch (err) {
    workerErr = err
    logger.error(
      { provider, orgId, err: err instanceof Error ? err.message : String(err) },
      '[nango-fetch] Worker error'
    )
  } finally {
    // Always release the concurrency slot — even on crash, OOM, or early return.
    // Without this, the slot counter increments forever and future jobs queue up
    // in pending_background_jobs but never dispatch.
    try { await releaseSlot(orgId, sourceType || provider) } catch { /* best-effort */ }

    // Reset connection status so the admin UI reflects final state
    try {
      const updateFields: Record<string, unknown> = {
        status: workerErr ? 'error' : 'active',
      };
      if (!workerErr) {
        // Stamp last_synced_at so the UI and usage stats can show when data was last pulled
        updateFields.last_synced_at = new Date().toISOString();
      }
      await supabaseAdmin
        .from('connections')
        .update(updateFields)
        .eq('id', connectionId)
    } catch { /* best-effort */ }

    // Bust stale caches: the sync just changed doc counts + last_synced_at
    redis.del(
      `dashboard_stats:${orgId}`,
      connectionsKey(orgId),
    ).catch(() => {})
  }

  if (workerErr) {
    return NextResponse.json(
      { error: workerErr instanceof Error ? workerErr.message : 'Internal error' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    status: 'ok',
    provider,
    chunks_fetched: allChunks.length,
    chunks_indexed: fetchResult?.indexed ?? 0,
    errors: fetchResult?.errors ?? 0,
  })
}
