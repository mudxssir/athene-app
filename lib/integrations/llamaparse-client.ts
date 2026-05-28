import 'server-only'
import { logger } from '@/lib/logger'
import type { ParsedTable } from './tabular-analysis'

export interface LlamaParseResult {
  text: string
  tables: ParsedTable[]
}

const LLAMAPARSE_UPLOAD_URL = 'https://api.cloud.llamaindex.ai/api/parsing/upload'
const SUPPORTED_EXTS = new Set(['pdf', 'docx', 'pptx', 'ppt'])

/** Returns null if LLAMAPARSE_API_KEY is not set or the file type is not supported — caller falls back. */
export async function parseWithLlamaParse(
  fileName: string,
  buffer: Buffer,
): Promise<LlamaParseResult | null> {
  const apiKey = process.env.LLAMAPARSE_API_KEY
  if (!apiKey) return null

  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (!SUPPORTED_EXTS.has(ext)) return null

  try {
    // 1. Upload file
    const formData = new FormData()
    formData.append('file', new Blob([new Uint8Array(buffer)]), fileName)
    formData.append('result_type', 'markdown')
    formData.append('premium_mode', 'false')

    const uploadRes = await fetch(LLAMAPARSE_UPLOAD_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    })

    if (!uploadRes.ok) {
      logger.warn({ status: uploadRes.status, fileName }, '[llamaparse] Upload failed')
      return null
    }

    const { id: jobId } = (await uploadRes.json()) as { id: string }

    // 2. Poll for completion (max 60s, 500ms interval)
    const deadline = Date.now() + 60_000
    let status = 'PENDING'
    while (status !== 'SUCCESS' && status !== 'ERROR' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500))
      const statusRes = await fetch(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!statusRes.ok) break
      const body = (await statusRes.json()) as { status: string }
      status = body.status
    }

    if (status !== 'SUCCESS') {
      logger.warn({ status, jobId, fileName }, '[llamaparse] Job did not complete successfully')
      return null
    }

    // 3. Fetch markdown result
    const resultRes = await fetch(
      `https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/markdown`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    )
    if (!resultRes.ok) return null
    const { markdown } = (await resultRes.json()) as { markdown: string }

    return extractTablesFromMarkdown(markdown)
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), fileName }, '[llamaparse] Parsing failed (non-fatal)')
    return null
  }
}

/**
 * Splits LlamaParse markdown output into narrative text and structured tables.
 * Tables are identified as consecutive lines starting with `|`.
 */
function extractTablesFromMarkdown(markdown: string): LlamaParseResult {
  const lines = markdown.split('\n')
  const tables: ParsedTable[] = []
  const cleanLines: string[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Detect start of a markdown table block
    if (line.trimStart().startsWith('|')) {
      // Capture the heading/caption immediately before this block
      const precedingText = cleanLines[cleanLines.length - 1]?.trim() ?? ''
      const tableLabel = precedingText
        ? precedingText.replace(/^#+\s*/, '').slice(0, 120).replace(/[^\w\s\-().]/g, '') || `Table ${tables.length + 1}`
        : `Table ${tables.length + 1}`

      // Collect all contiguous table lines
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }

      const parsed = parseMarkdownTable(tableLabel, tableLines)
      if (parsed) tables.push(parsed)

      // Replace table block with a blank line in clean text
      cleanLines.push('')
      continue
    }

    cleanLines.push(line)
    i++
  }

  return {
    text: cleanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    tables,
  }
}

function parseMarkdownTable(tableName: string, lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null

  const parseRow = (line: string): string[] =>
    line
      .split('|')
      .slice(1, -1) // trim leading and trailing pipes
      .map(cell => cell.trim())

  const headers = parseRow(lines[0])
  if (headers.length === 0) return null

  // Skip separator row (e.g. |---|---|)
  const dataStart = lines[1]?.replace(/[\s|:-]/g, '').length === 0 ? 2 : 1
  const rows = lines
    .slice(dataStart)
    .map(parseRow)
    .filter(r => r.some(c => c.length > 0))

  if (rows.length === 0) return null

  return { tableName, headers, rows }
}
