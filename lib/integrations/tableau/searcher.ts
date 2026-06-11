import { tableauSignIn, tableauFetch } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'

export async function tableauSearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const session = await tableauSignIn(connectionId, orgId)
  const chunks: FetchedChunk[] = []
  const filter = encodeURIComponent(`name:has:${query}`)

  try {
    const res = await tableauFetch<any>(session, `/sites/${session.siteId}/workbooks?filter=${filter}&pageSize=10`)
    const workbooks: any[] = res?.workbooks?.workbook ?? []
    for (const wb of workbooks) {
      chunks.push({
        chunk_id: `tableau_workbook_${wb.id}`,
        title: `Tableau: ${wb.name}`,
        content: wb.description ?? wb.name,
        source_url: wb.webpageUrl ?? `${session.serverUrl}/#/workbooks/${wb.id}`,
        shape: 'bi_artifact' as const,
        metadata: { provider: 'tableau', resource_type: 'workbook', workbook_id: wb.id },
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[tableau] Workbook search failed:')
  }

  try {
    const res = await tableauFetch<any>(session, `/sites/${session.siteId}/views?filter=${filter}&pageSize=10`)
    const views: any[] = res?.views?.view ?? []
    for (const view of views) {
      chunks.push({
        chunk_id: `tableau_view_${view.id}`,
        title: `Tableau View: ${view.name}`,
        content: view.name,
        source_url: `${session.serverUrl}/#/views/${view.contentUrl}`,
        shape: 'bi_artifact' as const,
        metadata: { provider: 'tableau', resource_type: 'view', view_id: view.id },
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[tableau] View search failed:')
  }

  return chunks
}
