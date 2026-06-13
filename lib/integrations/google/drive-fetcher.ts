import { googleFetch, googleFetchRaw } from './api-client'
import { supabaseAdmin } from '@/lib/supabase/server'
import type { FetchedChunk } from '@/lib/integrations/base'
import { assertSafeMetadata } from '@/lib/integrations/base'
import { logger } from '@/lib/logger'
import { type SyncConfig, getSelectedResourceIds, getExcludedResourceIds } from '@/lib/integrations/sync-config'
import { tabularChunksFromParsed, type ParsedTable } from '@/lib/integrations/tabular-analysis'
import { parseWithLlamaParse } from '@/lib/integrations/llamaparse-client'
import { maybeShadowParse } from '@/lib/integrations/sidecar-shadow'

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

  // Any other Google Workspace type (shortcuts, forms, drawings, etc.) can't be binary-downloaded
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return `[Unsupported binary format: ${mimeType}]`
  }

  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`
  const res = await googleFetchRaw(connectionId, orgId, url)
  // arrayBuffer() reads the full body stream — needs its own timeout since
  // AbortSignal.timeout on fetch() only covers the initial connection/headers
  const buffer = await withTimeout(res.arrayBuffer(), 60_000, 'arrayBuffer')

  if (mimeType.startsWith('text/')) {
    return new TextDecoder().decode(buffer)
  }

  if (EXTRACTABLE_BINARY[mimeType] === 'pdf') {
    const buf = Buffer.from(buffer)
    const text = await extractPdfText(buf)
    // P1-12 shadow mode: sampled sidecar parse + structural-diff log; observational
    // only, never affects the returned text and never throws.
    void maybeShadowParse(text, buf, `${fileId}.pdf`, orgId)
    return text
  }

  if (EXTRACTABLE_BINARY[mimeType] === 'docx') {
    const buf = Buffer.from(buffer)
    const text = await extractDocxText(buf)
    void maybeShadowParse(text, buf, `${fileId}.docx`, orgId)
    return text
  }

  if (EXTRACTABLE_BINARY[mimeType] === 'xlsx') {
    return extractXlsxText(Buffer.from(buffer))
  }

  return `[Unsupported binary format: ${mimeType}] (${buffer.byteLength} bytes)`
}

// ─── Timeout helper ──────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
}

// ─── Binary Text Extraction ─────────────────────────────────────────────────

const PDF_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

async function extractPdfText(buffer: Buffer): Promise<string> {
  if (buffer.byteLength > PDF_MAX_BYTES) {
    logger.warn({ bytes: buffer.byteLength }, '[drive-fetcher] PDF too large to extract, skipping')
    return `[PDF skipped: file is ${Math.round(buffer.byteLength / 1024 / 1024)}MB, exceeds 50MB limit]`
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>
    const data = await withTimeout(pdfParse(buffer), 30_000, 'pdf-parse')
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

/**
 * D7: parse an .xlsx workbook buffer into one ParsedTable per sheet for the
 * tabular engine (`tabularChunksFromParsed`). This is the lane-3 TS parse that
 * replaces the prose-emitting `extractXlsxText` in the indexing flow — XLSX rows
 * become stats/sample/agg chunks (Tier C, deterministic) instead of flat
 * 200-row windows re-split at 512 tokens. Returns [] when no sheet has a header
 * row plus at least one populated data row (degenerate workbook → caller skips).
 */
export function parseXlsxBufferToTables(buffer: Buffer): ParsedTable[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const XLSX = require('xlsx') as typeof import('xlsx')
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const tables: ParsedTable[] = []

    for (const sheetName of workbook.SheetNames) {
      const rawRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[sheetName], {
        header: 1,
        defval: '',
        raw: false,
      }) as string[][]
      if (rawRows.length < 2) continue

      const headers = rawRows[0].map((h, i) => String(h).trim() || `col_${i + 1}`)
      const rows = rawRows
        .slice(1)
        .filter((r) => r.some((v) => String(v).trim() !== ''))
        .map((r) => r.map(String))
      if (rows.length === 0) continue

      tables.push({ tableName: sheetName, headers, rows })
    }

    return tables
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[drive-fetcher] XLSX tabular parse failed',
    )
    return []
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
    shape: 'prose' as const,
    metadata,
  }
}

// ─── Document table extraction (LlamaParse) ──────────────────────────────────

const LLAMAPARSE_BINARY_TYPES = new Set(['pdf', 'docx', 'pptx', 'ppt'])

/**
 * Fetches a binary Drive file (PDF/DOCX/PPTX) and returns FetchedChunk[].
 * When LlamaParse is configured, embedded tables are extracted and returned as
 * separate stats/sample/agg chunks alongside the narrative text chunk.
 * Falls back to a single flat-text chunk if LlamaParse is not available.
 */
async function fetchDocumentChunks(
  connectionId: string,
  orgId: string,
  file: DriveFile,
  buffer: Buffer,
  folderPath: string,
  departmentId?: string,
  skips?: Map<string, SkipRecord>,
): Promise<FetchedChunk[]> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  const sourceUrl = file.webViewLink || `https://drive.google.com/file/d/${file.id}`
  const chunkId = `drive:${file.id}`

  const chunks: FetchedChunk[] = []

  // D7: .xlsx workbooks route through the tabular engine (stats/sample/agg,
  // Tier C deterministic) instead of flat 512-token prose windows. One
  // ParsedTable per sheet; mirrors fetchSheetChunks for native Google Sheets.
  if (ext === 'xlsx' || EXTRACTABLE_BINARY[file.mimeType] === 'xlsx') {
    const tables = parseXlsxBufferToTables(buffer)
    if (tables.length > 0) {
      const tabularChunks = await tabularChunksFromParsed(
        tables,
        chunkId,
        file.name,
        sourceUrl,
        { withLlmAnalysis: false, provider: 'google_drive_tabular' },
      )
      for (const chunk of tabularChunks) {
        chunk.metadata.last_modified = file.modifiedTime
        chunk.metadata.author = file.owners?.[0]?.displayName
        chunk.metadata.folder_path = folderPath
        chunk.metadata.mime_type = file.mimeType
        if (departmentId) chunk.metadata.department_id = departmentId
      }
      if (tabularChunks.length > 0) return tabularChunks
    }
    // Degenerate workbook (no header+data sheet) → surface a skip rather than
    // re-routing to the prose path. Keeps extractXlsxText out of the flow (D7).
    skips?.set(`drive:${file.id}:xlsx-empty`, {
      external_id: `drive:${file.id}`,
      title: file.name,
      reason: '[Spreadsheet contains no parseable tables]',
    })
    return []
  }

  if (LLAMAPARSE_BINARY_TYPES.has(ext)) {
    const parsed = await parseWithLlamaParse(file.name, buffer)
    if (parsed) {
      // Table chunks
      if (parsed.tables.length > 0) {
        const tableChunks = await tabularChunksFromParsed(
          parsed.tables,
          chunkId,
          file.name,
          sourceUrl,
          { withLlmAnalysis: false, provider: 'google_drive_tabular' },
        )
        for (const chunk of tableChunks) {
          chunk.metadata.last_modified = file.modifiedTime
          chunk.metadata.author = file.owners?.[0]?.displayName
          chunk.metadata.folder_path = folderPath
          chunk.metadata.mime_type = file.mimeType
          if (departmentId) chunk.metadata.department_id = departmentId
        }
        chunks.push(...tableChunks)
      }
      // Narrative text chunk
      if (parsed.text.trim().length > 0) {
        const textChunk = driveFileToChunk(file, parsed.text, folderPath)
        if (departmentId) textChunk.metadata.department_id = departmentId
        chunks.push(textChunk)
      }
      if (chunks.length > 0) return chunks
    }
  }

  // Fallback: single flat-text chunk (LlamaParse not configured or non-LlamaParse type)
  const content = await fetchDriveFileContent(connectionId, orgId, file.id, file.mimeType)
  if (content.startsWith('[Unsupported binary format:')) {
    // P0-5 (audit D11/D12): dropped content must be visible, not silent.
    // Buffered per run (review F4); flushed in batches by fetchDriveChunks.
    skips?.set(`drive:${file.id}:${content.slice(0, 60)}`, {
      external_id: `drive:${file.id}`,
      title: file.name,
      reason: content,
    })
    return []
  }
  const fallbackChunk = driveFileToChunk(file, content, folderPath)
  if (departmentId) fallbackChunk.metadata.department_id = departmentId
  return [fallbackChunk]
}

// ─── Google Sheets tabular extraction ────────────────────────────────────────

/**
 * Exports a Google Sheet as CSV and converts it to stats/sample/agg FetchedChunk.
 * Replaces the flat-text path for GOOGLE_SHEET_MIME files.
 */
async function fetchSheetChunks(
  connectionId: string,
  orgId: string,
  file: DriveFile,
  folderPath: string,
  departmentId?: string,
): Promise<FetchedChunk[]> {
  const exportUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv`
  const res = await googleFetchRaw(connectionId, orgId, exportUrl)
  const csvText = await res.text()

  // Parse CSV into rows using the same xlsx-backed parser used in uploads
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require('xlsx') as typeof import('xlsx')
  const wb = XLSX.read(csvText, { type: 'string', raw: false })
  const sheetName = wb.SheetNames[0]
  let table: ParsedTable = { tableName: file.name, headers: [], rows: [] }

  if (sheetName) {
    const rawRows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName], {
      header: 1,
      defval: '',
      raw: false,
    }) as string[][]
    if (rawRows.length >= 2) {
      const headers = rawRows[0].map((h, i) => (String(h).trim() || `col_${i + 1}`))
      const dataRows = rawRows.slice(1)
        .filter(r => r.some(v => String(v).trim() !== ''))
        .map(r => r.map(String))
      table = { tableName: file.name, headers, rows: dataRows }
    }
  }

  const sourceUrl = file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}`

  // Fall back to flat CSV text if the sheet has no parseable data rows
  if (table.headers.length === 0 || table.rows.length === 0) {
    const content = csvText.trim() || '[Google Sheet — no content]'
    const chunk = driveFileToChunk(file, content, folderPath)
    if (departmentId) chunk.metadata.department_id = departmentId
    return [chunk]
  }

  const tabularChunks = await tabularChunksFromParsed(
    [table],
    `drive:${file.id}`,
    file.name,
    sourceUrl,
    { withLlmAnalysis: false, provider: 'google_sheets' },
  )

  for (const chunk of tabularChunks) {
    chunk.metadata.last_modified = file.modifiedTime
    chunk.metadata.author = file.owners?.[0]?.displayName
    chunk.metadata.folder_path = folderPath
    chunk.metadata.mime_type = file.mimeType
    if (departmentId) chunk.metadata.department_id = departmentId
  }

  return tabularChunks
}

// ─── Skip telemetry buffer (P0-5, review F4) ─────────────────────────────────

/**
 * Per-sync-run buffer for skipped-content telemetry. Media-heavy Drives can
 * skip thousands of files per sync; buffering dedupes within the run and
 * flushes in batches instead of one upsert per file.
 */
type SkipRecord = { external_id: string; title: string; reason: string }

async function flushSyncSkips(
  orgId: string,
  connectionId: string,
  skips: Map<string, SkipRecord>,
): Promise<void> {
  if (skips.size === 0) return
  const now = new Date().toISOString()
  const rows = Array.from(skips.values()).map((r) => ({
    org_id: orgId,
    connection_id: connectionId,
    external_id: r.external_id,
    title: r.title,
    reason: r.reason.slice(0, 200),
    last_seen: now,
  }))
  const BATCH = 200
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabaseAdmin
      .from('sync_skips')
      .upsert(rows.slice(i, i + BATCH), { onConflict: 'org_id,connection_id,external_id,reason' })
    if (error) {
      logger.warn({ count: rows.length, err: error.message }, '[drive-fetcher] Failed to flush sync skips (non-fatal)')
      return
    }
  }
}

// ─── Abort signal ────────────────────────────────────────────────────────────

/** Thrown when the caller signals mid-sync abort. Caught by the worker to set status=paused. */
export class AbortSyncError extends Error {
  constructor() { super('Sync aborted by user'); this.name = 'AbortSyncError' }
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
  shouldAbort?: () => Promise<boolean>,
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
  const skips = new Map<string, SkipRecord>()

  if (selectedIds && selectedIds.size > 0) {
    const chunks: FetchedChunk[] = []

    // Build a quick type lookup from syncConfig so we can route files vs folders
    const resourceTypeMap = new Map<string, string>()
    for (const r of syncConfig?.selectedResources ?? []) {
      resourceTypeMap.set(r.id, r.type)
    }

    for (const resourceId of selectedIds) {
      if (shouldAbort && await shouldAbort()) throw new AbortSyncError()
      if (excludedIds.has(resourceId)) continue

      const resourceType = resourceTypeMap.get(resourceId) ?? 'folder'

      if (resourceType === 'file') {
        // Fetch file metadata then extract content directly
        try {
          const metaUrl = `https://www.googleapis.com/drive/v3/files/${resourceId}?fields=id,name,mimeType,webViewLink,modifiedTime,owners&supportsAllDrives=true`
          const fileMeta = await googleFetch<DriveFile>(connectionId, orgId, metaUrl)
          if (fileMeta.mimeType === GOOGLE_FOLDER_MIME) {
            // Misclassified as file — treat as folder
            const folderChunks = await fetchDriveFolder(connectionId, orgId, resourceId, excludedIds, excludedMimeTypes, '/', undefined, departmentId, visited, shouldAbort, skips)
            chunks.push(...folderChunks)
          } else if (fileMeta.mimeType === GOOGLE_SHEET_MIME) {
            const sheetChunks = await fetchSheetChunks(connectionId, orgId, fileMeta, '/', departmentId ?? undefined)
            chunks.push(...sheetChunks)
          } else {
            // Download buffer once so fetchDocumentChunks can pass it to LlamaParse
            const url = `https://www.googleapis.com/drive/v3/files/${fileMeta.id}?alt=media&supportsAllDrives=true`
            const res = await googleFetchRaw(connectionId, orgId, url)
            const buffer = Buffer.from(await withTimeout(res.arrayBuffer(), 60_000, 'arrayBuffer'))
            const docChunks = await fetchDocumentChunks(connectionId, orgId, fileMeta, buffer, '/', departmentId ?? undefined, skips)
            chunks.push(...docChunks)
          }
        } catch (err) {
          if (err instanceof AbortSyncError) throw err
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
          visited,
          shouldAbort,
          skips,
        )
        chunks.push(...folderChunks)
      }
    }
    await flushSyncSkips(orgId, connectionId, skips)
    return chunks
  }

  const folderChunks = await fetchDriveFolder(
    connectionId,
    orgId,
    undefined,
    excludedIds,
    excludedMimeTypes,
    '/',
    undefined,
    departmentId,
    visited,
    shouldAbort,
    skips,
  )
  await flushSyncSkips(orgId, connectionId, skips)
  return folderChunks
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
  shouldAbort?: () => Promise<boolean>,
  skips?: Map<string, SkipRecord>,
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
      if (shouldAbort && await shouldAbort()) throw new AbortSyncError()
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
          visited,
          shouldAbort,
          skips,
        )
        chunks.push(...sub)
        continue
      }
      try {
        if (file.mimeType === GOOGLE_SHEET_MIME) {
          const sheetChunks = await fetchSheetChunks(connectionId, orgId, file, folderPath, departmentId)
          chunks.push(...sheetChunks)
        } else {
          const url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`
          const res = await googleFetchRaw(connectionId, orgId, url)
          const buffer = Buffer.from(await withTimeout(res.arrayBuffer(), 60_000, 'arrayBuffer'))
          const docChunks = await fetchDocumentChunks(connectionId, orgId, file, buffer, folderPath, departmentId, skips)
          chunks.push(...docChunks)
        }
      } catch (err) {
        if (err instanceof AbortSyncError) throw err
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
