import { metabaseFetch } from './client'
import { FetchedChunk } from '../base'
import { getProviderMetadata } from '../base'
import { logger } from '@/lib/logger'

export async function metabaseSearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const meta = await getProviderMetadata(connectionId, 'metabase', orgId)
  const instanceUrl = (meta.instance_url as string | undefined)?.replace(/\/$/, '') ?? ''
  const chunks: FetchedChunk[] = []

  try {
    const res = await metabaseFetch<any>(connectionId, orgId, `/search?q=${encodeURIComponent(query)}&type=card&type=dashboard`)
    const results: any[] = res?.data ?? []
    for (const item of results) {
      const isCard = item.model === 'card'
      chunks.push({
        chunk_id: `metabase_${item.model}_${item.id}`,
        title: `Metabase ${isCard ? 'Question' : 'Dashboard'}: ${item.name}`,
        content: item.description ?? item.name,
        source_url: `${instanceUrl}/${isCard ? 'question' : 'dashboard'}/${item.id}`,
        shape: 'bi_artifact' as const,
        metadata: {
          provider: 'metabase',
          resource_type: item.model,
          item_id: String(item.id),
        },
      })
    }
  } catch (err) {
    logger.error({ err }, '[metabase] Search failed')
  }

  return chunks
}
