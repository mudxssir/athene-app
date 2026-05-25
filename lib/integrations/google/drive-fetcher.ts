import { googleFetch, googleFetchRaw } from './api-client'
import { supabaseAdmin } from '@/lib/supabase/server'
import type { FetchedChunk } from '@/lib/integrations/base'
import { assertSafeMetadata } from '@/lib/integrations/base'
import { logger } from '@/lib/logger'
import { type SyncConfig, getSelectedResourceIds, getExcludedResourceIds } from '@/lib/integrations/sync-config'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  webViewLink?: string
  modifiedTime?: string
  owners?: Array<{ displayName: string; emailAddress: string }>
}

export interface DriveListResponse {
  files: DriveFile[]
  nextPageToken?: string
}

export interface DriveChange {
  fileId: string
  removed: boolean
  file?: DriveFile
}

export interface DriveChangesResponse {
  changes: DriveChange[]
  newPageToken: string
}

// ─── Google MIME type constants ───────────────────────────────────────────────

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'
const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const GOOGLE_SLIDES_MIME = 'application/vnd.google-apps.presentation'
const GOOGLE_FOLDER_MIME = 'application/vnd.google-apps.folder'

/** MIME types we can extract real text from */
const EXTRACTABLE_BINARY: Record<string, 'pdf' | 'docx' | 'xlsx'> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

// ─── Listing & Searching ─────────────────────────────────────────────────────

/**
 * Lists files in a user's Google Drive, including Shared Drives.
 */
export async function listDriveFiles(
  connectionId: string,
  orgId: string,
  folderId?: string,
  pageToken?: string,
  pageSize: number = 50
): Promise<DriveListResponse> {
  const q = folderId
    ? `'${folderId}' in parents and trashed=false`
    : 'trashed=false'

  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,webViewLink,modifiedTime,owners),nextPageToken',
    pageSize: String(pageSize),
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  if (pageToken) params.set('pageToken', pageToken)

  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`
  return googleFetch<DriveListResponse>(connectionId, orgId, url)
}

/**
 * Lists Shared Drives the user has access to.
 */
export async function listSharedDrives(
  connectionId: string,
  orgId: string
): Promise<{ drives: Array<{ id: string; name: string }> }> {
  const url = 'https://www.googleapis.com/drive/v3/drives'
  return googleFetch<any>(connectionId, orgId, url)
}

/**
 * Full-text search across a user's Google Drive, including Shared Drives.
 */
export async function searchDrive(
  connectionId: string,
  orgId: string,
  query: string,
  pageToken?: string
): Promise<DriveListResponse> {
  const escapedQuery = query.replace(/'/g, "\\'")
  const q = `fullText contains '${escapedQuery}' and trashed=false`

  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,webViewLink,modifiedTime,owners),nextPageToken',
    pageSize: '20',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  if (pageToken) params.set('pageToken', pageToken)

  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`
  return googleFetch<DriveListResponse>(connectionId, orgId, url)
}

// ─── Content Extraction ──────────────────────────────────────────────────────

/**
 * Fetches the text content of a Google Drive file.
 */
export async function fetchDriveFileContent(
  connectionId: string,
  orgId: string,
  fileId: string,
  mimeType: string
): Promise<string> {
  if (mimeType === GOOGLE_DOC_MIME) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
    const res = await googleFetchRaw(connectionId, orgId, url)
    return res.text()
  }

  if (mimeType === GOOGLE_SHEET_MIME) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`
    const res = await googleFetchRaw(connectionId, orgId, url)
    return res.text()
  }

  if (mimeType === GOOGLE_SLIDES_MIME) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`
    const res = await googleFetchRaw(connectionId, orgId, url)
    return res.text()
  }

  if (mimeType === GOOGLE_FOLDER_MIME) {
    return '[Google Drive Folder — no content to extract]'
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`
  const res = await googleFetchRaw(connectionId, orgId, url)
  const buffer = await res.arrayBuffer()

  if (mimeType.startsWith('text/')) {
    return new TextDecoder().decode(buffer)
  }

  if (EXTRACTABLE_BINARY[mimeType] === 'pdf') {
    return extractPdfText(Buffer.from(buffer))
  }

  if (EXTRACTABLE_BINARY[mimeType] === 'docx') {
    return extractDocxText(Buffer.from(buffer))
  }

  if (EXTRACTABLE_BINARY[mimeType] === 'xlsx') {
    return extractXlsxText(Buffer.from(buffer))
  }

  return `[Unsupported binary format: ${mimeType}] (${buffer.byteLength} bytes)`
}

// ─── Binary Text Extraction ─────────────────────────────────────────────────

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>
    const data = await pdfParse(buffer)
    const text = data.text?.trim()
    if (!text) return '[PDF contains no extractable text (image-only?)]'
    return text
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[drive-fetcher] PDF extraction failed')
    return '[PDF text extraction failed]'
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mammoth = require('mammoth') as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> }
    const result = await mammoth.extractRawText({ buffer })
    const text = result.value?.trim()
    if (!text) return '[DOCX contains no extractable text]'
    return text
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[drive-fetcher] DOCX extraction failed')
    return '[DOCX text extraction failed]'
  }
}

async function extractXlsxText(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const XLSX = require('xlsx') as typeof import('xlsx')
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const sections: string[] = []

    const CHUNK_ROWS = 200 // Rows per sub-chunk within a sheet

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      // header: 1 → each row is a string[] (index 0 = first row / headers)
      const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' }) as string[][]
      if (rows.length === 0) continue

      const headers = rows[0]
      const headerLine = headers.join(',')
      const dataRows = rows.slice(1)

      sections.push(`=== Sheet: ${sheetName} ===`)

      if (dataRows.length === 0) {
        // Sheet has only headers — emit them so the column names are indexed
        sections.push(headerLine)
        continue
      }

      // Emit data in CHUNK_ROWS windows, each prefixed with the header row so
      // every downstream chunk is self-contained and queryable even after splitting
      for (let i = 0; i < dataRows.length; i += CHUNK_ROWS) {
        const window = dataRows.slice(i, i + CHUNK_ROWS)
        const csvChunk = [headerLine, ...window.map((r) => r.join(','))].join('\n')
        sections.push(csvChunk)
      }
    }

    const text = sections.join('\n\n').trim()
    if (!text) return '[XLSX contains no extractable text]'
    return text
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[drive-fetcher] XLSX extraction failed')
    return '[XLSX text extraction failed]'
  }
}

// ─── FetchedChunk Builders ──────────────────────────────────────────────────

/**
 * Converts a DriveFile + its extracted content into a FetchedChunk
 * ready for the indexing pipeline (indexDocument).
 *
 * @param file - The DriveFile metadata from the listing.
 * @param content - The extracted text content from fetchDriveFileContent.
 * @param folderPath - The recursive path to show in file metadata.
 * @returns A FetchedChunk that can be passed to indexDocument.
 */
export function driveFileToChunk(file: DriveFile, content: string, folderPath: string = '/'): FetchedChunk {
  const metadata: FetchedChunk['metadata'] = {
    provider: 'google',
    resource_type: 'drive_file',
    last_modified: file.modifiedTime,
    author: file.owners?.[0]?.displayName,
    mime_type: file.mimeType,
    folder_path: folderPath,
  }
  assertSafeMetadata(metadata)

  return {
    chunk_id: `drive:${file.id}`,
    title: file.name,
    content,
    source_url: file.webViewLink || `https://drive.google.com/file/d/${file.id}`,
    metadata,
  }
}

// ─── Full Pipeline ──────────────────────────────────────────────────────────

/**
 * Full indexing pipeline entry point for Drive.
 * Respects selected folders and Shared Drives from SyncConfig,
 * and loads department mapping and excluded MIME types from Supabase.
 */
export async function fetchDriveChunks(
  connectionId: string,
  orgId: string,
  _folderId?: string,
  syncConfig?: SyncConfig,
): Promise<FetchedChunk[]> {
  // Load connection metadata from Supabase with cross-tenant check
  const { data: conn } = await supabaseAdmin
    .from('connections')
    .select('metadata, department_id')
    .eq('nango_connection_id', connectionId)
    .eq('org_id', orgId)
    .maybeSingle()
  
  const storedMeta = (conn?.metadata as any) ?? {}
  const departmentId = conn?.department_id as string | undefined
  const excludedMimeTypes = storedMeta.excluded_mime_types as string[] | undefined ?? []

  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const excludedIds = syncConfig ? getExcludedResourceIds(syncConfig) : new Set<string>()

  const visited = new Set<string>()

  if (selectedIds && selectedIds.size > 0) {
    const chunks: FetchedChunk[] = []

    // Build a quick type lookup from syncConfig so we can route files vs folders
    const resourceTypeMap = new Map<string, string>()
    for (const r of syncConfig?.selectedResources ?? []) {
      resourceTypeMap.set(r.id, r.type)
    }

    for (const resourceId of selectedIds) {
      if (excludedIds.has(resourceId)) continue

      const resourceType = resourceTypeMap.get(resourceId) ?? 'folder'

      if (resourceType === 'file') {
        // Fetch file metadata then extract content directly
        try {
          const metaUrl = `https://www.googleapis.com/drive/v3/files/${resourceId}?fields=id,name,mimeType,webViewLink,modifiedTime,owners&supportsAllDrives=true`
          const fileMeta = await googleFetch<DriveFile>(connectionId, orgId, metaUrl)
          if (fileMeta.mimeType === GOOGLE_FOLDER_MIME) {
            // Misclassified as file — treat as folder
            const folderChunks = await fetchDriveFolder(connectionId, orgId, resourceId, excludedIds, excludedMimeTypes, '/', undefined, departmentId, visited)
            chunks.push(...folderChunks)
          } else {
            const content = await fetchDriveFileContent(connectionId, orgId, fileMeta.id, fileMeta.mimeType)
            if (!content.startsWith('[Unsupported binary format:')) {
              chunks.push(driveFileToChunk(fileMeta, content, '/'))
            }
          }
        } catch (err) {
          logger.warn({ resourceId, err: err instanceof Error ? err.message : String(err) }, '[drive-fetcher] Failed to fetch selected file')
        }
      } else {
        // Folder — recurse into it
        const folderChunks = await fetchDriveFolder(
          connectionId,
          orgId,
          resourceId,
          excludedIds,
          excludedMimeTypes,
          '/',
          undefined,
          departmentId,
          visited
        )
        chunks.push(...folderChunks)
      }
    }
    return chunks
  }

  return fetchDriveFolder(
    connectionId,
    orgId,
    undefined,
    excludedIds,
    excludedMimeTypes,
    '/',
    undefined,
    departmentId,
    visited
  )
}

/**
 * Fetches all files from a single Drive folder (or Shared Drive root), recursively.
 */
async function fetchDriveFolder(
  connectionId: string,
  orgId: string,
  folderId: string | undefined,
  excludedIds: Set<string>,
  excludedMimeTypes: string[] = [],
  folderPath: string = '/',
  driveId?: string,
  departmentId?: string,
  visited: Set<string> = new Set<string>(),
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []
  let pageToken: string | undefined

  do {
    const q = folderId
      ? `'${folderId}' in parents and trashed=false`
      : 'trashed=false'

    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,mimeType,webViewLink,modifiedTime,owners),nextPageToken',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    })
    if (driveId) {
      params.set('driveId', driveId)
      params.set('corpora', 'drive')
    }
    if (pageToken) params.set('pageToken', pageToken)

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`
    const listing = await googleFetch<DriveListResponse>(connectionId, orgId, url)

    for (const file of listing.files) {
      if (excludedIds.has(file.id)) continue
      if (excludedMimeTypes.includes(file.mimeType)) continue
      if (visited.has(file.id)) continue
      visited.add(file.id)

      if (file.mimeType === GOOGLE_FOLDER_MIME) {
        const nextPath = folderPath === '/' ? `/${file.name}` : `${folderPath}/${file.name}`
        const sub = await fetchDriveFolder(
          connectionId,
          orgId,
          file.id,
          excludedIds,
          excludedMimeTypes,
          nextPath,
          driveId,
          departmentId,
          visited
        )
        chunks.push(...sub)
        continue
      }
      try {
        const content = await fetchDriveFileContent(connectionId, orgId, file.id, file.mimeType)
        if (content.startsWith('[Unsupported binary format:')) continue
        const chunk = driveFileToChunk(file, content, folderPath)
        if (departmentId) chunk.metadata.department_id = departmentId
        chunks.push(chunk)
      } catch (err) {
        logger.warn({ fileId: file.id, fileName: file.name, err: err instanceof Error ? err.message : String(err) }, '[drive-fetcher] Skipping file')
      }
    }
    pageToken = listing.nextPageToken
  } while (pageToken)

  return chunks
}

// ─── Delta Sync (Changes API) ────────────────────────────────────────────────

export async function getStartPageToken(connectionId: string, orgId: string): Promise<string> {
  const url = 'https://www.googleapis.com/drive/v3/changes/startPageToken'
  const res = await googleFetch<{ startPageToken: string }>(connectionId, orgId, url)
  return res.startPageToken
}

export async function fetchChanges(connectionId: string, orgId: string, pageToken: string): Promise<DriveChangesResponse> {
  const params = new URLSearchParams({
    pageToken,
    fields: 'changes(fileId,removed,file(id,name,mimeType,modifiedTime)),newStartPageToken,nextPageToken',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  const url = `https://www.googleapis.com/drive/v3/changes?${params.toString()}`
  const res = await googleFetch<{
    changes: DriveChange[]
    newStartPageToken?: string
    nextPageToken?: string
  }>(connectionId, orgId, url)

  return {
    changes: res.changes || [],
    newPageToken: res.newStartPageToken || res.nextPageToken || pageToken,
  }
}
