import 'server-only'
import { HumanMessage } from '@langchain/core/messages'
import type { FetchedChunk } from './base'
import {
  buildStatsChunk,
  buildSampleChunk,
  buildAggregationChunk,
  classifyColumn,
  type ColumnSchema,
  type TableStats,
  type AggregationResult,
} from './bi-chunking'
import { resolveModelClient } from '@/lib/langgraph/llm-factory'
import { logger } from '@/lib/logger'

// ---- Types -------------------------------------------------------

export interface ParsedTable {
  tableName: string
  headers: string[]
  rows: string[][]
}

// ---- Column type inference ----------------------------------------

/**
 * P4-4: a column is classified by type when ≥95% of its non-empty sampled values
 * match — replacing the old `every()` (100%) rule. A single stray cell ("N/A", a
 * footnote, a unit suffix) no longer flips a numeric/date column to varchar and
 * drops its stats. The 5% tolerance is small enough that genuinely mixed columns
 * still fall through to varchar.
 */
const TYPE_INFERENCE_THRESHOLD = 0.95

function fractionMatching(values: string[], pred: (v: string) => boolean): number {
  if (values.length === 0) return 0
  let n = 0
  for (const v of values) if (pred(v)) n++
  return n / values.length
}

const isNumeric = (v: string): boolean => !isNaN(parseFloat(v)) && isFinite(Number(v))
// length > 4 avoids misclassifying short numeric tokens (zip codes, IDs) as dates
const isDateLike = (v: string): boolean => v.length > 4 && !isNaN(Date.parse(v))

export function inferSchema(headers: string[], rows: string[][]): ColumnSchema[] {
  const SAMPLE = Math.min(rows.length, 50)

  return headers.map((name, colIdx) => {
    const colName = name.trim() || `col_${colIdx + 1}`
    const values = rows
      .slice(0, SAMPLE)
      .map(r => (r[colIdx] ?? '').trim())
      .filter(v => v !== '')

    if (values.length === 0) return { name: colName, type: 'varchar' }

    if (fractionMatching(values, isNumeric) >= TYPE_INFERENCE_THRESHOLD) {
      return { name: colName, type: 'number' }
    }

    if (fractionMatching(values, isDateLike) >= TYPE_INFERENCE_THRESHOLD) {
      return { name: colName, type: 'date' }
    }

    return { name: colName, type: 'varchar' }
  })
}

// ---- In-memory statistics ----------------------------------------

function computeStats(
  tableName: string,
  schema: ColumnSchema[],
  rows: string[][],
): TableStats {
  const numeric: TableStats['numeric'] = []
  const categorical: TableStats['categorical'] = []
  const dates: TableStats['dates'] = []

  for (let i = 0; i < schema.length; i++) {
    const col = schema[i]
    const kind = classifyColumn(col.type)
    const values = rows.map(r => (r[i] ?? '').trim()).filter(v => v !== '')

    if (kind === 'numeric') {
      const nums = values.map(Number).filter(n => !isNaN(n))
      if (nums.length === 0) continue
      let min = Infinity, max = -Infinity, sum = 0
      for (const n of nums) {
        if (n < min) min = n
        if (n > max) max = n
        sum += n
      }
      numeric.push({
        col: col.name,
        min: String(min),
        max: String(max),
        avg: (sum / nums.length).toFixed(2),
        sum: String(sum),
      })
    } else if (kind === 'categorical') {
      const freq = new Map<string, number>()
      for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1)
      const topValues = Array.from(freq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count: String(count) }))
      categorical.push({ col: col.name, distinct: freq.size, topValues })
    } else if (kind === 'date') {
      const sorted = values.filter(v => !isNaN(Date.parse(v))).sort()
      if (sorted.length > 0) {
        dates.push({ col: col.name, min: sorted[0], max: sorted[sorted.length - 1] })
      }
    }
  }

  return { tableName, rowCount: rows.length, schema, numeric, categorical, dates }
}

function computeAggregations(schema: ColumnSchema[], rows: string[][]): AggregationResult[] {
  const results: AggregationResult[] = []
  const numericCols = schema.filter(c => classifyColumn(c.type) === 'numeric').slice(0, 3)
  const catCols = schema.filter(c => classifyColumn(c.type) === 'categorical').slice(0, 2)

  // SUM aggregations: numeric metric grouped by categorical dimension
  for (const cat of catCols) {
    const catIdx = schema.findIndex(c => c.name === cat.name)
    for (const num of numericCols) {
      const numIdx = schema.findIndex(c => c.name === num.name)
      const groupSums = new Map<string, number>()
      for (const row of rows) {
        const dimVal = (row[catIdx] ?? '').trim()
        const metricVal = parseFloat(row[numIdx] ?? '')
        if (!dimVal || isNaN(metricVal)) continue
        groupSums.set(dimVal, (groupSums.get(dimVal) ?? 0) + metricVal)
      }
      const topRows = Array.from(groupSums.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([dimValue, sum]) => ({ dimValue, metricValue: sum.toFixed(2) }))
      if (topRows.length > 0) {
        results.push({ dimension: cat.name, metric: `sum(${num.name})`, rows: topRows })
      }
    }
  }

  // COUNT DISTINCT: covers event/log tables that have no numeric columns
  // For each categorical dimension, count how many rows per distinct value
  for (const cat of catCols) {
    const catIdx = schema.findIndex(c => c.name === cat.name)
    const groupCounts = new Map<string, number>()
    for (const row of rows) {
      const dimVal = (row[catIdx] ?? '').trim()
      if (!dimVal) continue
      groupCounts.set(dimVal, (groupCounts.get(dimVal) ?? 0) + 1)
    }
    const topRows = Array.from(groupCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([dimValue, count]) => ({ dimValue, metricValue: String(count) }))
    if (topRows.length > 0) {
      results.push({ dimension: cat.name, metric: `count`, rows: topRows })
    }
  }

  return results
}

// ---- LLM analysis -----------------------------------------------

/**
 * Generates a narrative analysis by feeding the pre-computed stats and
 * aggregations to the BYOK-resolved LLM. Uses statistical summaries
 * (covering all rows) rather than a raw row sample so the analysis
 * reflects the full dataset regardless of size.
 */
async function generateAnalysis(
  tableName: string,
  statsContent: string,
  aggContent: string,
  sampleContent: string,
  orgId?: string,
): Promise<string | null> {
  try {
    const safeTableName = tableName.slice(0, 120).replace(/[^\w\s\-().]/g, '')
    const contextParts = [statsContent]
    if (aggContent) contextParts.push(aggContent)
    contextParts.push(`Sample rows:\n${sampleContent}`)

    const llm = await resolveModelClient('simple', orgId, 0)
    const result = await llm.invoke([
      new HumanMessage(
        `Based on this statistical profile of an enterprise data table named "${safeTableName}", provide a concise analysis covering: (1) what this data represents, (2) key metrics and dimensions, (3) notable patterns or trends, (4) data quality observations. Be specific. Output plain text.\n\n${contextParts.join('\n\n')}`
      ),
    ])

    // LangChain content is a string or array of content blocks depending on provider
    const raw = result.content
    const text = typeof raw === 'string'
      ? raw.trim()
      : (raw as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text!)
          .join('')
          .trim()

    return text || null
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), tableName }, '[tabular-analysis] LLM analysis skipped (non-fatal)')
    return null
  }
}

// ---- Main export -------------------------------------------------

const MAX_DATA_ROWS = 10_000

/**
 * Converts in-memory parsed tables into separate FetchedChunk[] per
 * semantic type (stats / sample / aggregations / analysis), mirroring
 * the Snowflake/BigQuery pipeline so each chunk gets its own focused
 * embedding. The chunk_id suffix differentiates them while keeping
 * the base ID consistent for delta-sync idempotency.
 */
export async function tabularChunksFromParsed(
  tables: ParsedTable[],
  chunkId: string,
  title: string,
  sourceUrl: string,
  opts?: { withLlmAnalysis?: boolean; provider?: string; orgId?: string },
): Promise<FetchedChunk[]> {
  const provider = opts?.provider ?? 'direct_upload_tabular'
  const chunks: FetchedChunk[] = []

  for (const table of tables) {
    const { tableName, headers, rows } = table
    if (headers.length === 0 || rows.length === 0) continue

    const sheetSuffix = tables.length > 1 ? `:${tableName}` : ''
    const schema = inferSchema(headers, rows)
    const dataRows = rows.slice(0, MAX_DATA_ROWS)
    const stats = computeStats(tableName, schema, dataRows)
    const aggResults = computeAggregations(schema, dataRows)

    const rowRecords: Record<string, string>[] = dataRows.slice(0, 50).map(r =>
      Object.fromEntries(schema.map((col, i) => [col.name, (r[i] ?? '').trim()]))
    )

    const statsChunk = buildStatsChunk(tableName, stats, provider, sourceUrl)
    const sampleChunk = buildSampleChunk(tableName, schema, rowRecords, provider, sourceUrl)

    // Assign stable chunk_ids so upserts are idempotent on re-index
    chunks.push({ ...statsChunk, chunk_id: `${chunkId}${sheetSuffix}:stats` })
    chunks.push({ ...sampleChunk, chunk_id: `${chunkId}${sheetSuffix}:sample` })

    if (aggResults.length > 0) {
      const aggChunk = buildAggregationChunk(tableName, aggResults, provider, sourceUrl)
      chunks.push({ ...aggChunk, chunk_id: `${chunkId}${sheetSuffix}:agg` })
    }

    if (opts?.withLlmAnalysis) {
      const analysis = await generateAnalysis(
        tableName,
        statsChunk.content,
        aggResults.length > 0 ? buildAggregationChunk(tableName, aggResults, provider, sourceUrl).content : '',
        sampleChunk.content,
        opts.orgId,
      )
      if (analysis) {
        chunks.push({
          chunk_id: `${chunkId}${sheetSuffix}:analysis`,
          title: `${title}${tables.length > 1 ? ` — ${tableName}` : ''} — Analysis`,
          content: analysis,
          source_url: sourceUrl,
          shape: 'bi_artifact' as const,
          metadata: { provider, resource_type: 'spreadsheet_analysis' },
        })
      }
    }
  }

  return chunks
}
