import { lookerFetch, lookerInstanceUrl } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'

export async function lookerSearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const instanceUrl = await lookerInstanceUrl(connectionId, orgId)
  const chunks: FetchedChunk[] = []
  const q = encodeURIComponent(query)

  try {
    const looks = await lookerFetch<any[]>(connectionId, orgId, `/looks/search?title=${q}&limit=10`)
    for (const look of looks ?? []) {
      chunks.push({
        chunk_id: `looker_look_${look.id}`,
        title: `Looker Look: ${look.title}`,
        content: look.description ?? look.title,
        source_url: `${instanceUrl}/looks/${look.id}`,
        shape: 'bi_artifact' as const,
        metadata: { provider: 'looker', resource_type: 'look', look_id: String(look.id) },
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[looker] Look search failed:')
  }

  try {
    const dashboards = await lookerFetch<any[]>(connectionId, orgId, `/dashboards/search?title=${q}&limit=10`)
    for (const dash of dashboards ?? []) {
      chunks.push({
        chunk_id: `looker_dashboard_${dash.id}`,
        title: `Looker Dashboard: ${dash.title}`,
        content: dash.description ?? dash.title,
        source_url: `${instanceUrl}/dashboards/${dash.id}`,
        shape: 'bi_artifact' as const,
        metadata: { provider: 'looker', resource_type: 'dashboard', dashboard_id: String(dash.id) },
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[looker] Dashboard search failed:')
  }

  return chunks
}
