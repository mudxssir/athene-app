import { lookerFetch, lookerInstanceUrl } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'
import { type SyncConfig, getSelectedResourceIds } from '../sync-config'

interface LookerLook {
  id: number
  title: string
  description: string | null
  short_url: string
}

interface LookerDashboard {
  id: string
  title: string
  description: string | null
}

export async function fetchLookerContent(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig
): Promise<FetchedChunk[]> {
  const instanceUrl = await lookerInstanceUrl(connectionId, orgId)
  const chunks: FetchedChunk[] = []

  // browseLooker returns IDs prefixed with "look:{id}" and "dashboard:{id}".
  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const shouldInclude = (prefix: string, id: string | number) =>
    !selectedIds || selectedIds.size === 0 || selectedIds.has(`${prefix}:${id}`)

  // Fetch Looks
  try {
    const looks = await lookerFetch<LookerLook[]>(connectionId, orgId, '/looks?limit=200')
    for (const look of looks ?? []) {
      if (!shouldInclude('look', look.id)) continue
      try {
        // Run the look to get actual data; pass parameters: [] so parameterized looks still run
        const data = await lookerFetch<any[]>(connectionId, orgId, `/looks/${look.id}/run/json?limit=100`, { method: 'POST', body: { parameters: [] } })
        const rowContent = (data ?? []).slice(0, 50).map((row) =>
          Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', ')
        ).join('\n')

        chunks.push({
          chunk_id: `looker_look_${look.id}`,
          title: `Looker Look: ${look.title}`,
          content: [look.description, rowContent].filter(Boolean).join('\n\n'),
          source_url: `${instanceUrl}/looks/${look.id}`,
          metadata: {
            provider: 'looker',
            resource_type: 'look',
            look_id: String(look.id),
          },
        })
      } catch (err) {
        // Look may require parameters — index metadata only
        chunks.push({
          chunk_id: `looker_look_${look.id}`,
          title: `Looker Look: ${look.title}`,
          content: look.description ?? look.title,
          source_url: `${instanceUrl}/looks/${look.id}`,
          metadata: {
            provider: 'looker',
            resource_type: 'look',
            look_id: String(look.id),
          },
        })
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[looker] Failed to fetch looks:')
  }

  // Fetch Dashboards
  try {
    const dashboards = await lookerFetch<LookerDashboard[]>(connectionId, orgId, '/dashboards?limit=50')
    for (const dash of dashboards ?? []) {
      if (!shouldInclude('dashboard', dash.id)) continue
      chunks.push({
        chunk_id: `looker_dashboard_${dash.id}`,
        title: `Looker Dashboard: ${dash.title}`,
        content: dash.description ?? dash.title,
        source_url: `${instanceUrl}/dashboards/${dash.id}`,
        metadata: {
          provider: 'looker',
          resource_type: 'dashboard',
          dashboard_id: String(dash.id),
        },
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[looker] Failed to fetch dashboards:')
  }

  return chunks
}
