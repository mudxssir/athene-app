import { metabaseFetch } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'
import { type SyncConfig, getSelectedResourceIds } from '../sync-config'

interface MetabaseCard {
  id: number
  name: string
  description: string | null
  display: string
  database_id: number | null
}

interface MetabaseDashboard {
  id: number
  name: string
  description: string | null
}

export async function fetchMetabaseContent(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig
): Promise<FetchedChunk[]> {
  const meta = await import('../base').then((m) => m.getProviderMetadata(connectionId, 'metabase', orgId))
  const instanceUrl = (meta.instance_url as string | undefined)?.replace(/\/$/, '') ?? ''
  const chunks: FetchedChunk[] = []

  // browseMetabase returns IDs prefixed with "card:{id}" and "dashboard:{id}".
  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const shouldInclude = (prefix: string, id: number) =>
    !selectedIds || selectedIds.size === 0 || selectedIds.has(`${prefix}:${id}`)

  // Fetch Questions (Cards)
  try {
    const cards = await metabaseFetch<MetabaseCard[]>(connectionId, orgId, '/card')
    for (const card of cards ?? []) {
      if (!shouldInclude('card', card.id)) continue
      // Run the card query to get sample data
      let sampleData = ''
      try {
        const queryRes = await metabaseFetch<any>(connectionId, orgId, `/card/${card.id}/query`, { method: 'POST', body: {} })
        const rows: any[][] = queryRes?.data?.rows ?? []
        const cols: { name: string }[] = queryRes?.data?.cols ?? []
        sampleData = rows.slice(0, 30).map((row) =>
          cols.map((c, i) => `${c.name}: ${row[i]}`).join(', ')
        ).join('\n')
      } catch {
        // Non-fatal — some cards require parameters
      }

      chunks.push({
        chunk_id: `metabase_card_${card.id}`,
        title: `Metabase: ${card.name}`,
        content: [card.description, sampleData].filter(Boolean).join('\n\n') || card.name,
        source_url: `${instanceUrl}/question/${card.id}`,
        shape: 'bi_artifact' as const,
        metadata: {
          provider: 'metabase',
          resource_type: 'question',
          card_id: String(card.id),
          display_type: card.display,
        },
      })
    }
  } catch (err) {
    logger.error({ err }, '[metabase] Failed to fetch cards')
  }

  // Fetch Dashboards
  try {
    const dashboards = await metabaseFetch<MetabaseDashboard[]>(connectionId, orgId, '/dashboard')
    for (const dash of dashboards ?? []) {
      if (!shouldInclude('dashboard', dash.id)) continue
      chunks.push({
        chunk_id: `metabase_dashboard_${dash.id}`,
        title: `Metabase Dashboard: ${dash.name}`,
        content: dash.description ?? dash.name,
        source_url: `${instanceUrl}/dashboard/${dash.id}`,
        shape: 'bi_artifact' as const,
        metadata: {
          provider: 'metabase',
          resource_type: 'dashboard',
          dashboard_id: String(dash.id),
        },
      })
    }
  } catch (err) {
    logger.error({ err }, '[metabase] Failed to fetch dashboards')
  }

  return chunks
}
