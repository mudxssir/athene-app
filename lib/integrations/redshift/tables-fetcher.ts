// ============================================================
// Redshift tables fetcher — 3-chunk strategy (ATH-B1)
//
// Replaces the flat SELECT * LIMIT 100 row-dump with the same
// stats + sample + aggregation chunks used by Snowflake.
// Uses information_schema for schema discovery.
// ============================================================

import { getRedshiftCredentials, redshiftQuery } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'
import {
  buildStatsChunk,
  buildSampleChunk,
  buildAggregationChunk,
  classifyColumn,
  type ColumnSchema,
  type TableStats,
  type NumericStat,
  type CategoricalStat,
  type DateStat,
  type AggregationResult,
} from '../bi-chunking'

const TABLE_IDENT = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/
const SAMPLE_LIMIT = 50

export async function fetchRedshiftTables(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  const creds = await getRedshiftCredentials(connectionId, orgId)
  const chunks: FetchedChunk[] = []

  // Safety guard: empty allowlist would trigger full-schema auto-discovery, potentially
  // indexing sensitive tables. Fail loud rather than silently scan everything.
  if (!creds.allowlist || creds.allowlist.length === 0) {
    logger.warn({ connectionId }, '[redshift] No allowlist configured — skipping sync to prevent accidental full indexing')
    return []
  }

  const tables = creds.allowlist

  for (const tableFullName of tables) {
    if (!TABLE_IDENT.test(tableFullName)) continue

    const sourceUrl = `redshift://${creds.clusterId}/${creds.database}/${tableFullName}`

    try {
      // 1. Schema discovery via information_schema
      const [schema_name, table_name] = tableFullName.includes('.')
        ? tableFullName.split('.')
        : ['public', tableFullName]

      const schemaRows = await redshiftQuery(
        creds,
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = '${schema_name}'
           AND table_name   = '${table_name}'
         ORDER BY ordinal_position`
      )
      const schema: ColumnSchema[] = schemaRows.map((r) => ({
        name: String(r.column_name),
        type: String(r.data_type),
      }))
      if (schema.length === 0) continue

      // 2. Row count
      const countRows = await redshiftQuery(creds, `SELECT COUNT(*) AS row_count FROM ${tableFullName}`)
      const rowCount  = countRows.length > 0 ? Number(countRows[0]['row_count'] ?? 0) : 0

      // 3. Column statistics
      const stats = await buildRedshiftTableStats(creds, tableFullName, schema, rowCount)
      chunks.push(buildStatsChunk(tableFullName, stats, 'redshift', sourceUrl))

      // 4. Sample rows
      const sampleRows = (await redshiftQuery(
        creds,
        `SELECT * FROM ${tableFullName} LIMIT ${SAMPLE_LIMIT}`
      )).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? '')])))

      if (sampleRows.length > 0) {
        chunks.push(buildSampleChunk(tableFullName, schema, sampleRows, 'redshift', sourceUrl))
      }

      // 5. Aggregations
      const aggResults = await buildRedshiftAggregations(creds, tableFullName, schema, rowCount)
      if (aggResults.length > 0) {
        chunks.push(buildAggregationChunk(tableFullName, aggResults, 'redshift', sourceUrl))
      }
    } catch (err: any) {
      logger.error({ tableFullName, err: err.message }, '[redshift] Failed to process table')
    }
  }

  return chunks
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function buildRedshiftTableStats(
  creds: import('./client').RedshiftCredentials,
  tableFullName: string,
  schema: ColumnSchema[],
  rowCount: number,
): Promise<TableStats> {
  const numeric: NumericStat[]       = []
  const categorical: CategoricalStat[] = []
  const dates: DateStat[]            = []

  const numericCols    = schema.filter((c) => classifyColumn(c.type) === 'numeric').slice(0, 5)
  const categoricalCols = schema.filter((c) => classifyColumn(c.type) === 'categorical').slice(0, 5)
  const dateCols       = schema.filter((c) => classifyColumn(c.type) === 'date').slice(0, 3)

  // Numeric stats in one query
  if (numericCols.length > 0) {
    const selects = numericCols.flatMap((c) => [
      `MIN(${c.name}::FLOAT) AS ${c.name}_min`,
      `MAX(${c.name}::FLOAT) AS ${c.name}_max`,
      `AVG(${c.name}::FLOAT) AS ${c.name}_avg`,
      `SUM(${c.name}::FLOAT) AS ${c.name}_sum`,
    ])
    try {
      const rows = await redshiftQuery(creds, `SELECT ${selects.join(', ')} FROM ${tableFullName}`)
      if (rows.length > 0) {
        const row = rows[0]
        for (const c of numericCols) {
          numeric.push({
            col: c.name,
            min: String(row[`${c.name}_min`] ?? ''),
            max: String(row[`${c.name}_max`] ?? ''),
            avg: String(row[`${c.name}_avg`] ?? ''),
            sum: String(row[`${c.name}_sum`] ?? ''),
          })
        }
      }
    } catch { /* non-fatal */ }
  }

  // TABLESAMPLE is only cost-effective above 10k rows; below that a full scan is
  // cheaper and avoids returning an empty result set from 1% of a tiny table.
  const useSample = rowCount > 10_000
  // Categorical top-N values
  for (const c of categoricalCols) {
    try {
      // TABLESAMPLE BERNOULLI(1) = 1% random row sampling, SQL:2003 standard syntax.
      // Redshift evaluates the sample before the GROUP BY, reducing scan cost by ~99%.
      const fromClause = useSample
        ? `${tableFullName} TABLESAMPLE BERNOULLI(1)`
        : tableFullName
      const rows = await redshiftQuery(
        creds,
        `SELECT ${c.name}::VARCHAR AS val, COUNT(*) AS cnt
         FROM ${fromClause}
         GROUP BY val ORDER BY cnt DESC LIMIT 20`
      )
      categorical.push({
        col: c.name,
        distinct: rows.length,
        topValues: rows.map((r) => ({ value: String(r['val'] ?? ''), count: String(r['cnt'] ?? '') })),
      })
    } catch { /* non-fatal */ }
  }

  // Date ranges
  if (dateCols.length > 0) {
    const selects = dateCols.flatMap((c) => [
      `MIN(${c.name}::VARCHAR) AS ${c.name}_min`,
      `MAX(${c.name}::VARCHAR) AS ${c.name}_max`,
    ])
    try {
      const rows = await redshiftQuery(creds, `SELECT ${selects.join(', ')} FROM ${tableFullName}`)
      if (rows.length > 0) {
        const row = rows[0]
        for (const c of dateCols) {
          dates.push({
            col: c.name,
            min: String(row[`${c.name}_min`] ?? ''),
            max: String(row[`${c.name}_max`] ?? ''),
          })
        }
      }
    } catch { /* non-fatal */ }
  }

  return { tableName: tableFullName, rowCount, schema, numeric, categorical, dates }
}

async function buildRedshiftAggregations(
  creds: import('./client').RedshiftCredentials,
  tableFullName: string,
  schema: ColumnSchema[],
  rowCount: number,
): Promise<AggregationResult[]> {
  const results: AggregationResult[] = []
  const numericCols    = schema.filter((c) => classifyColumn(c.type) === 'numeric').slice(0, 3)
  const categoricalCols = schema.filter((c) => classifyColumn(c.type) === 'categorical').slice(0, 2)

  if (numericCols.length === 0 || categoricalCols.length === 0) return results

  const useSampleAgg = rowCount > 10_000
  for (const metric of numericCols) {
    for (const dim of categoricalCols) {
      try {
        const fromClause = useSampleAgg
          ? `${tableFullName} TABLESAMPLE BERNOULLI(1)`
          : tableFullName
        const rows = await redshiftQuery(
          creds,
          `SELECT ${dim.name}::VARCHAR AS dim_val, SUM(${metric.name}::FLOAT) AS metric_sum
           FROM ${fromClause}
           GROUP BY dim_val ORDER BY metric_sum DESC LIMIT 10`
        )
        if (rows.length === 0) continue
        results.push({
          dimension: dim.name,
          metric: metric.name,
          rows: rows.map((r) => ({
            dimValue:    String(r['dim_val']    ?? ''),
            metricValue: String(r['metric_sum'] ?? ''),
          })),
        })
      } catch { /* non-fatal */ }
    }
  }

  return results
}
