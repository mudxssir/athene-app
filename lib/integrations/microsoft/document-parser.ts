import mammoth from 'mammoth'
import * as pdf from 'pdf-parse'
import ExcelJS from 'exceljs'

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
