// ============================================================
// BigQuery datasets fetcher — 3-chunk strategy (ATH-B1)
//
// Replaces the flat SELECT * LIMIT 50 row-dump with the same
// stats + sample + aggregation chunks used by Snowflake/Redshift.
// Uses BigQuery's INFORMATION_SCHEMA for schema discovery and
// jobs.query for all SQL execution.
// ============================================================

import { bigqueryFetch, bigqueryProjectId, parseBigQueryRows } from './client'
import { FetchedChunk, getProviderMetadata } from '../base'
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

// Maximum rows to sample per table
const SAMPLE_LIMIT = 50

export async function fetchBigQueryDatasets(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  const projectId = await bigqueryProjectId(connectionId, orgId)

  // Load allowlist from Nango metadata (set via configure endpoint)
  const meta: Record<string, any> = await getProviderMetadata(connectionId, 'bigquery', orgId).catch(() => ({}))
  const allowlist: Set<string> | null = Array.isArray(meta.allowlist) && (meta.allowlist as string[]).length > 0
    ? new Set(meta.allowlist as string[])
    : null

  const chunks: FetchedChunk[] = []

  const datasetsRes = await bigqueryFetch<any>(connectionId, orgId, '/datasets')
  const datasets: { datasetReference: { datasetId: string } }[] = datasetsRes?.datasets ?? []

  for (const ds of datasets) {
    const datasetId = ds.datasetReference.datasetId

    let tablesRes: any
    try {
      tablesRes = await bigqueryFetch<any>(connectionId, orgId, `/datasets/${datasetId}/tables`)
    } catch (err: any) {
      logger.error({ datasetId, err: err.message }, '[bigquery] Failed to list tables in dataset')
      continue
    }

    const tables: { tableReference: { tableId: string }; kind: string }[] = tablesRes?.tables ?? []

    for (const table of tables) {
      const tableId = table.tableReference.tableId

      // Skip tables not in allowlist (if one is configured)
      if (allowlist && !allowlist.has(`${datasetId}.${tableId}`)) continue

      const fullTableId = `${projectId}.${datasetId}.${tableId}`
      const backtickId  = `\`${fullTableId}\``
      const sourceUrl   = `https://console.cloud.google.com/bigquery?project=${projectId}&p=${projectId}&d=${datasetId}&t=${tableId}&page=table`

      try {
        // 1. Fetch schema from BigQuery tables API (returns fields[] with name + type)
        const tableDetail = await bigqueryFetch<any>(
          connectionId, orgId,
          `/datasets/${datasetId}/tables/${tableId}`
        )
        const fields: { name: string; type: string }[] = tableDetail?.schema?.fields ?? []
        if (fields.length === 0) continue

        const schema: ColumnSchema[] = fields.map((f) => ({ name: f.name, type: f.type }))

        // 2. Row count
        const countRes = await runQuery(connectionId, orgId, `SELECT COUNT(*) AS row_count FROM ${backtickId}`)
        const rowCount = countRes.length > 0 ? Number(countRes[0]['row_count'] ?? 0) : 0

        // 3. Build column statistics
        const stats = await buildBigQueryTableStats(
          connectionId, orgId, fullTableId, backtickId, schema, rowCount
        )

        chunks.push(buildStatsChunk(fullTableId, stats, 'bigquery', sourceUrl))

        // 4. Sample rows
        const sampleRows = await runQuery(
          connectionId, orgId,
          `SELECT * FROM ${backtickId} LIMIT ${SAMPLE_LIMIT}`
        )
        if (sampleRows.length > 0) {
          chunks.push(buildSampleChunk(fullTableId, schema, sampleRows, 'bigquery', sourceUrl))
        }

        // 5. Aggregations
        const aggResults = await buildBigQueryAggregations(
          connectionId, orgId, backtickId, schema, rowCount
        )
        if (aggResults.length > 0) {
          chunks.push(buildAggregationChunk(fullTableId, aggResults, 'bigquery', sourceUrl))
        }
      } catch (err: any) {
        logger.error({ fullTableId, err: err.message }, '[bigquery] Failed to process table')
      }
    }
  }

  return chunks
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function runQuery(
  connectionId: string,
  orgId: string,
  sql: string,
): Promise<Record<string, string>[]> {
  const res = await bigqueryFetch<any>(connectionId, orgId, '/queries', {
    method: 'POST',
    body: {
      query: sql,
      useLegacySql: false,
      timeoutMs: 30000,
      maxResults: 500,
    },
  })
  return parseBigQueryRows(res) as Record<string, string>[]
}

async function buildBigQueryTableStats(
  connectionId: string,
  orgId: string,
  fullTableId: string,
  backtickId: string,
  schema: ColumnSchema[],
  rowCount: number,
): Promise<TableStats> {
  const numeric: NumericStat[] = []
  const categorical: CategoricalStat[] = []
  const dates: DateStat[] = []

  const numericCols    = schema.filter((c) => classifyColumn(c.type) === 'numeric').slice(0, 5)
  const categoricalCols = schema.filter((c) => classifyColumn(c.type) === 'categorical').slice(0, 5)
  const dateCols       = schema.filter((c) => classifyColumn(c.type) === 'date').slice(0, 3)

  // Numeric stats in one query
  if (numericCols.length > 0) {
    const selects = numericCols.flatMap((c) => [
      `MIN(CAST(${c.name} AS FLOAT64)) AS ${c.name}_min`,
      `MAX(CAST(${c.name} AS FLOAT64)) AS ${c.name}_max`,
      `AVG(CAST(${c.name} AS FLOAT64)) AS ${c.name}_avg`,
      `SUM(CAST(${c.name} AS FLOAT64)) AS ${c.name}_sum`,
    ])
    try {
      const rows = await runQuery(
        connectionId, orgId,
        `SELECT ${selects.join(', ')} FROM ${backtickId}`
      )
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

  // Categorical top-N values
  // TABLESAMPLE is only cost-effective above 10k rows; below that a full scan is
  // cheaper and avoids returning an empty sample from 1% of a tiny table.
  const useSample = rowCount > 10_000
  for (const c of categoricalCols) {
    try {
      // TABLESAMPLE SYSTEM (1 PERCENT) is BigQuery's standard sampling syntax —
      // evaluated server-side before the GROUP BY, dramatically reducing slot usage.
      const source = useSample
        ? `(SELECT CAST(${c.name} AS STRING) AS val FROM ${backtickId} TABLESAMPLE SYSTEM (1 PERCENT))`
        : `(SELECT CAST(${c.name} AS STRING) AS val FROM ${backtickId})`
      const rows = await runQuery(
        connectionId, orgId,
        `SELECT val, COUNT(*) AS cnt FROM ${source} GROUP BY val ORDER BY cnt DESC LIMIT 20`
      )
      categorical.push({
        col: c.name,
        distinct: rows.length,
        topValues: rows.map((r) => ({ value: String(r['val'] ?? ''), count: String(r['cnt'] ?? '') })),
      })
    } catch { /* non-fatal */ }
  }

  // Date ranges in one query
  if (dateCols.length > 0) {
    const selects = dateCols.flatMap((c) => [
      `MIN(CAST(${c.name} AS STRING)) AS ${c.name}_min`,
      `MAX(CAST(${c.name} AS STRING)) AS ${c.name}_max`,
    ])
    try {
      const rows = await runQuery(
        connectionId, orgId,
        `SELECT ${selects.join(', ')} FROM ${backtickId}`
      )
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

  return { tableName: fullTableId, rowCount, schema, numeric, categorical, dates }
}

async function buildBigQueryAggregations(
  connectionId: string,
  orgId: string,
  backtickId: string,
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
          ? `${backtickId} TABLESAMPLE SYSTEM (1 PERCENT)`
          : backtickId
        const rows = await runQuery(
          connectionId, orgId,
          `SELECT CAST(${dim.name} AS STRING) AS dim_val,
                  SUM(CAST(${metric.name} AS FLOAT64)) AS metric_sum
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
