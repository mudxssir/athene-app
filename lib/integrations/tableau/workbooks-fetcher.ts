import { tableauSignIn, tableauFetch } from './client'
import { FetchedChunk, baseFetchRaw } from '../base'
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

  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null

  let workbooks: TableauWorkbook[] = []
  try {
    const res = await tableauFetch<any>(session, `/sites/${session.siteId}/workbooks?pageSize=50`)
    workbooks = res?.workbooks?.workbook ?? []
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[tableau] Failed to fetch workbooks')
    return chunks
  }

  // Fetch all workbook view lists in parallel — independent per-workbook calls
  const filteredWorkbooks = workbooks.filter(
    (wb) => !selectedIds || selectedIds.size === 0 || selectedIds.has(wb.id)
  )

  await Promise.all(filteredWorkbooks.map(async (wb) => {
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

    // Fetch all view CSV data samples in parallel — independent per-view calls
    const viewChunks = await Promise.all(views.map(async (view) => {
      let dataContent = ''
      try {
        const csvUrl = `${session.serverUrl}/api/3.21/sites/${session.siteId}/views/${view.id}/data.csv?pageSize=50`
        const res = await baseFetchRaw(csvUrl, {
          headers: { 'X-Tableau-Auth': session.token },
        })
        if (res.ok) {
          const csv = await res.text()
          if (csv.trim()) dataContent = `\n\nData Sample:\n${csv.trim()}`
        }
      } catch (err) {
        // Non-fatal: some views require parameters or live connections
        logger.warn(
          { viewId: view.id, workbookId: wb.id, err: err instanceof Error ? err.message : String(err) },
          '[tableau] Failed to fetch view CSV data — indexing metadata only'
        )
      }

      const baseContent = `View "${view.name}" in workbook "${wb.name}". Project: ${wb.project?.name ?? 'Default'}.`
      return {
        chunk_id: `tableau_view_${view.id}`,
        title: `Tableau View: ${view.name} (${wb.name})`,
        content: baseContent + dataContent,
        source_url: `${session.serverUrl}/#/site/default/views/${view.contentUrl}`,
        metadata: {
          provider: 'tableau',
          resource_type: 'view',
          view_id: view.id,
          workbook_id: wb.id,
          workbook_name: wb.name,
        },
      } satisfies FetchedChunk
    }))

    chunks.push(...viewChunks)
  }))

  return chunks
}
