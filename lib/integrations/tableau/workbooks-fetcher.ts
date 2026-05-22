import { tableauSignIn, tableauFetch } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'
import { type SyncConfig, getSelectedResourceIds } from '../sync-config'

interface TableauWorkbook {
  id: string
  name: string
  description: string
  webpageUrl: string
  project: { id: string; name: string }
}

interface TableauView {
  id: string
  name: string
  contentUrl: string
}

export async function fetchTableauWorkbooks(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig
): Promise<FetchedChunk[]> {
  const session = await tableauSignIn(connectionId, orgId)
  const chunks: FetchedChunk[] = []

  // browseTableau returns workbook UUIDs as resource IDs.
  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null

  let workbooks: TableauWorkbook[] = []
  try {
    const res = await tableauFetch<any>(session, `/sites/${session.siteId}/workbooks?pageSize=50`)
    workbooks = res?.workbooks?.workbook ?? []
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[tableau] Failed to fetch workbooks:')
    return chunks
  }

  for (const wb of workbooks) {
    if (selectedIds && selectedIds.size > 0 && !selectedIds.has(wb.id)) continue
    // Get views for this workbook
    let views: TableauView[] = []
    try {
      const viewRes = await tableauFetch<any>(session, `/sites/${session.siteId}/workbooks/${wb.id}/views`)
      views = viewRes?.views?.view ?? []
    } catch {
      // Non-fatal — index workbook without views
    }

    const viewNames = views.map((v) => v.name).join(', ')
    const content = [
      wb.description,
      viewNames ? `Views: ${viewNames}` : null,
      `Project: ${wb.project?.name ?? 'Default'}`,
    ].filter(Boolean).join('\n')

    chunks.push({
      chunk_id: `tableau_workbook_${wb.id}`,
      title: `Tableau: ${wb.name}`,
      content,
      source_url: wb.webpageUrl ?? `${session.serverUrl}/#/site/default/workbooks/${wb.id}`,
      metadata: {
        provider: 'tableau',
        resource_type: 'workbook',
        workbook_id: wb.id,
        project_name: wb.project?.name ?? '',
        view_count: String(views.length),
      },
    })

    // Index each view as its own chunk
    for (const view of views) {
      chunks.push({
        chunk_id: `tableau_view_${view.id}`,
        title: `Tableau View: ${view.name} (${wb.name})`,
        content: `View "${view.name}" in workbook "${wb.name}". Project: ${wb.project?.name ?? 'Default'}.`,
        source_url: `${session.serverUrl}/#/site/default/views/${view.contentUrl}`,
        metadata: {
          provider: 'tableau',
          resource_type: 'view',
          view_id: view.id,
          workbook_id: wb.id,
          workbook_name: wb.name,
        },
      })
    }
  }

  return chunks
}
