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

// ─── LookML Explore Indexing ─────────────────────────────────────────────────

interface LookerModel {
  name: string
  label: string | null
  explores: Array<{ name: string; label: string | null }>
}

interface LookerExplore {
  name: string
  label: string | null
  description: string | null
  fields?: {
    dimensions?: Array<{ name: string; label: string | null; type: string }>
    measures?: Array<{ name: string; label: string | null; type: string }>
  }
}

/**
 * Indexes LookML model/explore definitions — the core BI layer analysts query.
 * Each explore becomes a chunk listing its dimensions and measures so users can
 * ask "what metrics are available in the Sales explore?" and get answers.
 */
export async function fetchLookerExplores(
  connectionId: string,
  orgId: string,
): Promise<FetchedChunk[]> {
  const instanceUrl = await lookerInstanceUrl(connectionId, orgId)
  const chunks: FetchedChunk[] = []

  let models: LookerModel[] = []
  try {
    models = await lookerFetch<LookerModel[]>(connectionId, orgId, '/lookml_models?limit=50') ?? []
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[looker] Failed to fetch LookML models')
    return chunks
  }

  for (const model of models) {
    for (const exploreRef of model.explores ?? []) {
      try {
        const explore = await lookerFetch<LookerExplore>(
          connectionId,
          orgId,
          `/lookml_models/${encodeURIComponent(model.name)}/explores/${encodeURIComponent(exploreRef.name)}`,
        )
        if (!explore) continue

        const dims = (explore.fields?.dimensions ?? []).slice(0, 50)
        const measures = (explore.fields?.measures ?? []).slice(0, 20)

        const dimLine = dims.map((d) => `${d.label ?? d.name} (${d.type})`).join(', ')
        const measureLine = measures.map((m) => `${m.label ?? m.name} (${m.type})`).join(', ')

        const lines: string[] = [
          `Explore: ${explore.label ?? exploreRef.name}`,
          `Model: ${model.name}`,
        ]
        if (explore.description) lines.push(`Description: ${explore.description}`)
        if (dimLine) lines.push(`\nDimensions: ${dimLine}`)
        if (measureLine) lines.push(`Measures: ${measureLine}`)

        chunks.push({
          chunk_id: `looker_explore_${model.name}_${exploreRef.name}`,
          title: `Looker Explore: ${explore.label ?? exploreRef.name} (${model.label ?? model.name})`,
          content: lines.join('\n'),
          source_url: `${instanceUrl}/explore/${model.name}/${exploreRef.name}`,
          metadata: {
            provider: 'looker',
            resource_type: 'explore',
            model_name: model.name,
            explore_name: exploreRef.name,
          },
        })
      } catch (err) {
        logger.warn(
          { model: model.name, explore: exploreRef.name, err: err instanceof Error ? err.message : String(err) },
          '[looker] Failed to fetch explore definition — skipping',
        )
      }
    }
  }

  return chunks
}
