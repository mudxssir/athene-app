import { paginate, graphDownload, graphFetch } from './graph-client'
import { parseDocumentEnhanced } from './document-parser'
import type { ParsedTable } from '@/lib/integrations/tabular-analysis'
export async function listSharePointDocs(connectionId: string, orgId: string, siteId: string, itemId: string = 'root') {
  const items: any[] = []
  const endpoint = itemId === 'root' 
    ? `/sites/${siteId}/drive/root/children` 
    : `/sites/${siteId}/drive/items/${itemId}/children`
    
  for await (const item of paginate(connectionId, orgId, endpoint)) {
    if (item.file) {
      items.push(item)
    } else if (item.folder) {
      // Recurse to find all files in subfolders
      const children = await listSharePointDocs(connectionId, orgId, siteId, item.id)
      items.push(...children)
    }
  }
  return items
}

export async function fetchDocContent(
  connectionId: string,
  orgId: string,
  driveId: string,
  itemId: string,
): Promise<{ text: string; tables: ParsedTable[]; parser_used?: string }> {
  const item = await graphFetch(connectionId, orgId, `/drives/${driveId}/items/${itemId}`)
  const fileName = item.name.toLowerCase()
  const arrayBuffer = await graphDownload(connectionId, orgId, `/drives/${driveId}/items/${itemId}/content`)
  const buffer = Buffer.from(arrayBuffer)
  // sourceDocId matches the chunk_id index.ts builds (ms_sharepoint_${id}) so
  // media_queue stubs link back to the parent document.
  return parseDocumentEnhanced(fileName, buffer, { orgId, sourceDocId: `ms_sharepoint_${itemId}` })
}

/**
 * Fetches the assigned permissions for a specific SharePoint document.
 * This includes who has access (people, groups) and what role they have.
 */
export async function getSharePointItemPermissions(connectionId: string, orgId: string, driveId: string, itemId: string) {
  const data = await graphFetch(connectionId, orgId, `/drives/${driveId}/items/${itemId}/permissions`)
  return data.value // Returns a list of Permission objects
}
