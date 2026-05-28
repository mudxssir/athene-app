import mammoth from 'mammoth'
import * as pdf from 'pdf-parse'
import ExcelJS from 'exceljs'
import type { ParsedTable } from '@/lib/integrations/tabular-analysis'
import { parseWithLlamaParse } from '@/lib/integrations/llamaparse-client'

export async function parseDocument(fileName: string, buffer: Buffer): Promise<string> {
  if (fileName.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer })
    return result.value
  } else if (fileName.endsWith('.pdf')) {
    const pdfParser = (pdf as any).default || pdf
    const data = await pdfParser(buffer)
    return data.text
  } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as any)
    let text = ''
    workbook.eachSheet((sheet) => {
      text += `Sheet: ${sheet.name}\n`
      sheet.eachRow((row) => {
        const rowValues = Array.isArray(row.values) 
          ? row.values.slice(1).map(v => (v && typeof v === 'object' ? JSON.stringify(v) : String(v || ''))).join(',')
          : ''
        text += rowValues + '\n'
      })
      text += '\n'
    })
    return text
  } else if (fileName.endsWith('.txt')) {
    return buffer.toString('utf-8')
  } else if (fileName.endsWith('.csv') || fileName.endsWith('.tsv')) {
    // Plain text delimited files — UTF-8 decode is correct
    return buffer.toString('utf-8')
  } else {
    // Unknown binary format (e.g. .pptx, images, .zip) — returning raw bytes as
    // UTF-8 produces garbage that corrupts the vector store. Skip cleanly instead.
    const ext = fileName.includes('.') ? `.${fileName.split('.').pop()}` : ''
    return `[Unsupported file type: ${ext || 'unknown'} — skipped]`
  }
}

/**
 * Parses tabular files (CSV, TSV, XLSX, XLS) into structured row arrays.
 * Returns null for non-tabular file types — callers fall back to parseDocument().
 * First row is always treated as the header row.
 */
export async function parseDocumentStructured(
  fileName: string,
  buffer: Buffer,
): Promise<ParsedTable[] | null> {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()

  if (ext === 'csv' || ext === 'tsv') {
    // Use xlsx library for robust CSV parsing (handles quoted fields with commas)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const XLSX = require('xlsx') as typeof import('xlsx')
    const opts = ext === 'tsv' ? { FS: '\t' } : {}
    const wb = XLSX.read(buffer, { type: 'buffer', raw: true, ...opts })
    const sheetName = wb.SheetNames[0]
    if (!sheetName) return null
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName], {
      header: 1,
      defval: '',
      raw: false,
    }) as string[][]
    if (rows.length < 2) return null
    const headers = rows[0].map((h, i) => (String(h).trim() || `col_${i + 1}`))
    const dataRows = rows.slice(1).filter(r => r.some(v => String(v).trim() !== ''))
    if (dataRows.length === 0) return null
    const baseName = fileName.replace(/\.[^.]+$/, '')
    return [{ tableName: baseName, headers, rows: dataRows.map(r => r.map(String)) }]
  }

  if (ext === 'xlsx' || ext === 'xls') {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer as any)
    const tables: ParsedTable[] = []
    workbook.eachSheet(sheet => {
      const allRows: string[][] = []
      sheet.eachRow(row => {
        const vals = Array.isArray(row.values)
          ? row.values.slice(1).map(v => (v && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')))
          : []
        allRows.push(vals)
      })
      if (allRows.length < 2) return
      const headers = allRows[0].map((h, i) => (h.trim() || `col_${i + 1}`))
      const dataRows = allRows.slice(1).filter(r => r.some(v => v.trim() !== ''))
      if (dataRows.length > 0) tables.push({ tableName: sheet.name, headers, rows: dataRows })
    })
    return tables.length > 0 ? tables : null
  }

  return null
}

const LLAMAPARSE_EXTS = new Set(['pdf', 'docx', 'pptx', 'ppt'])

/**
 * Enhanced document parser that extracts both narrative text and embedded tables.
 * For PDF/DOCX/PPTX: tries LlamaParse first; falls back to flat-text extraction if
 * LLAMAPARSE_API_KEY is not set or the API call fails.
 * For CSV/XLSX/TSV: delegates to parseDocumentStructured() (tabular-only path).
 * For other formats: delegates to parseDocument().
 */
export async function parseDocumentEnhanced(
  fileName: string,
  buffer: Buffer,
): Promise<{ text: string; tables: ParsedTable[] }> {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()

  // Tabular files — return structured rows with no narrative text
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'xls') {
    const tables = await parseDocumentStructured(fileName, buffer)
    return { text: '', tables: tables ?? [] }
  }

  // Rich documents — try LlamaParse for table extraction + narrative text
  if (LLAMAPARSE_EXTS.has(ext)) {
    const result = await parseWithLlamaParse(fileName, buffer)
    if (result) return result
    // Fallback: flat text only (LlamaParse not configured or failed)
    const text = await parseDocument(fileName, buffer)
    return { text, tables: [] }
  }

  // All other formats (txt, md, json, xml, html, etc.)
  const text = await parseDocument(fileName, buffer)
  return { text, tables: [] }
}
