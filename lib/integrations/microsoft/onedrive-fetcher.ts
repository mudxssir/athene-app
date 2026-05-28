import { paginate, graphDownload, graphFetch } from './graph-client'
import { parseDocumentEnhanced } from './document-parser'
import type { ParsedTable } from '@/lib/integrations/tabular-analysis'
import { type SyncConfig, getSelectedResourceIds } from '../sync-config'

/**
 * Recursively fetches all file items under a given drive item ID.
 * Extracted as a standalone helper so multiple roots can be processed in parallel.
 */
async function fetchFolderRecursive(connectionId: string, orgId: string, itemId: string): Promise<any[]> {
  const items: any[] = []
  const endpoint = itemId === 'root'
    ? `/me/drive/root/children`
    : `/me/drive/items/${itemId}/children`

  for await (const item of paginate(connectionId, orgId, endpoint)) {
    if (item.file) {
      items.push(item)
    } else if (item.folder) {
      const children = await fetchFolderRecursive(connectionId, orgId, item.id)
      items.push(...children)
    }
  }
  return items
}

/**
 * Lists OneDrive files, scoped to selected folders when syncConfig is provided.
 * Falls back to full drive root enumeration when no resources are selected.
 */
export async function listOneDriveDocs(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig,
): Promise<any[]> {
  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const roots = selectedIds && selectedIds.size > 0
    ? Array.from(selectedIds)
    : ['root']

  const results = await Promise.all(
    roots.map((itemId) => fetchFolderRecursive(connectionId, orgId, itemId))
  )
  return results.flat()
}

export async function fetchOneDriveDocContent(
  connectionId: string,
  orgId: string,
  itemId: string,
): Promise<{ text: string; tables: ParsedTable[] }> {
  const item = await graphFetch(connectionId, orgId, `/me/drive/items/${itemId}`)
  const fileName = item.name.toLowerCase()
  const arrayBuffer = await graphDownload(connectionId, orgId, `/me/drive/items/${itemId}/content`)
  const buffer = Buffer.from(arrayBuffer)
  return parseDocumentEnhanced(fileName, buffer)
}

/**
 * Fetches the assigned permissions for a specific OneDrive item.
 */
export async function getOneDriveItemPermissions(connectionId: string, orgId: string, itemId: string) {
  const data = await graphFetch(connectionId, orgId, `/me/drive/items/${itemId}/permissions`)
  return data.value
}
