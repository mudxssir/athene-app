import { snowflakeFetch } from './client'
import { getConnection } from '@/lib/nango/client'
import { logger } from '@/lib/logger'
import {
  type ColumnSchema,
  type TableStats,
  type NumericStat,
  type CategoricalStat,
  type DateStat,
  classifyColumn,
  type SyncConfig,
} from '../bi-chunking'

export interface SnowflakeTable {
  database: string
  schema: string
  name: string
  fullName: string
}

/**
 * Lists available base tables from Snowflake INFORMATION_SCHEMA.
 * Capped at 200 results. Returns [] if the role lacks USAGE on INFORMATION_SCHEMA.
 */
export async function listSnowflakeTables(
  connectionId: string,
  orgId: string,
): Promise<SnowflakeTable[]> {
  const sql = `
    SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME
    LIMIT 200
  `
  const res = await snowflakeFetch(connectionId, orgId, sql)
  const rows = parseSnowflakeRows(res)
  return rows.map((r: any) => {
    const database = String(r.table_catalog ?? '')
    const schema = String(r.table_schema ?? '')
    const name = String(r.table_name ?? '')
    return { database, schema, name, fullName: `${database}.${schema}.${name}` }
  })
}

export interface TableSchema {
  database: string
  schema: string
  name: string
  columns: Array<{ name: string; type: string }>
}

export async function discoverSchema(connectionId: string, orgId: string): Promise<TableSchema[]> {
  const connection = await getConnection(connectionId, 'snowflake', orgId)
  const allowlist = connection.metadata?.allowlist as string[] | undefined

  if (!allowlist || allowlist.length === 0) {
    return []
  }

  const schemas: TableSchema[] = []

  // Snowflake SQL API returns data in row-column format.
  // We need to parse it to get our results.
  
  const identifierRegex = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/

  for (const tableFullName of allowlist) {
    if (!identifierRegex.test(tableFullName)) {
      logger.warn({ err: `Invalid Snowflake identifier in allowlist: ${tableFullName}. Skipping.` }, `Invalid Snowflake identifier in allowlist: ${tableFullName}. Skipping.`)
      continue
    }
    // Expected format: DATABASE.SCHEMA.TABLE or just TABLE if defaults set
    const parts = tableFullName.split('.')
    let database = ''
    let schema = ''
    let tableName = ''

    if (parts.length === 3) {
      [database, schema, tableName] = parts
    } else if (parts.length === 2) {
      [schema, tableName] = parts
    } else {
      tableName = parts[0]
    }

    try {
      // Get table info
      const describeRes = await snowflakeFetch(connectionId, orgId, `DESCRIBE TABLE ${tableFullName}`)
      
      const columns = parseSnowflakeRows(describeRes).map((row: any) => ({
        name: row.name,
        type: row.type
      }))

      schemas.push({
        database,
        schema,
        name: tableName,
        columns
      })
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, `Error describing table ${tableFullName}:`)
    }
  }

  return schemas
}

/** Fetch per-column statistics for a single table. */
export async function fetchTableStats(
  connectionId: string,
  orgId: string,
  tableFullName: string,
  schema: ColumnSchema[],
  syncConfig: SyncConfig,
): Promise<TableStats> {
  const numeric: NumericStat[] = []
  const categorical: CategoricalStat[] = []
  const dates: DateStat[] = []

  // Row count
  let rowCount = 0
  try {
    const countRes = await snowflakeFetch(connectionId, orgId, `SELECT COUNT(*) AS cnt FROM ${tableFullName}`)
    const rows = parseSnowflakeRows(countRes)
    rowCount = Number(rows[0]?.cnt ?? 0)
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, `[snowflake] Could not get row count for ${tableFullName}:`)
  }

  for (const col of schema) {
    const kind = classifyColumn(col.type)
    const quotedCol = col.name  // Snowflake identifiers are case-insensitive; skip quoting for simplicity

    if (kind === 'numeric') {
      try {
        const res = await snowflakeFetch(
          connectionId, orgId,
          `SELECT MIN(${quotedCol}) AS min_val, MAX(${quotedCol}) AS max_val, AVG(${quotedCol}) AS avg_val, SUM(${quotedCol}) AS sum_val FROM ${tableFullName}`
        )
        const row = parseSnowflakeRows(res)[0] ?? {}
        numeric.push({
          col: col.name,
          min: row.min_val ?? '',
          max: row.max_val ?? '',
          avg: row.avg_val != null ? Number(row.avg_val).toFixed(2) : '',
          sum: row.sum_val != null ? Number(row.sum_val).toLocaleString() : '',
        })
      } catch { /* non-fatal */ }
    } else if (kind === 'categorical') {
      try {
        const limit = syncConfig.stats_categorical_limit
        const distinctRes = await snowflakeFetch(
          connectionId, orgId,
          `SELECT COUNT(DISTINCT ${quotedCol}) AS cnt FROM ${tableFullName}`
        )
        const distinctCount = Number(parseSnowflakeRows(distinctRes)[0]?.cnt ?? 0)

        // SAMPLE (1) = 1% Bernoulli sampling, server-side before GROUP BY.
        // Snowflake's optimizer ignores SAMPLE on small tables (<10k rows), preserving accuracy.
        const topRes = await snowflakeFetch(
          connectionId, orgId,
          `SELECT val, COUNT(*) AS cnt FROM (SELECT ${quotedCol} AS val FROM ${tableFullName} SAMPLE (1)) GROUP BY val ORDER BY cnt DESC LIMIT ${limit}`
        )
        const topRows = parseSnowflakeRows(topRes)
        categorical.push({
          col: col.name,
          distinct: distinctCount,
          topValues: topRows.map((r: any) => ({ value: String(r.val ?? ''), count: String(r.cnt ?? '') })),
        })
      } catch { /* non-fatal */ }
    } else if (kind === 'date') {
      try {
        const res = await snowflakeFetch(
          connectionId, orgId,
          `SELECT MIN(${quotedCol}) AS min_val, MAX(${quotedCol}) AS max_val FROM ${tableFullName}`
        )
        const row = parseSnowflakeRows(res)[0] ?? {}
        dates.push({ col: col.name, min: String(row.min_val ?? ''), max: String(row.max_val ?? '') })
      } catch { /* non-fatal */ }
    }
  }

  return { tableName: tableFullName, rowCount, schema, numeric, categorical, dates }
}

/**
 * Parses Snowflake SQL API response into a more usable array of objects.
 */
export function parseSnowflakeRows(response: any): any[] {
  if (!response.resultSetMetaData || !response.data) {
    return []
  }

  const columns = response.resultSetMetaData.rowType.map((col: any) => col.name.toLowerCase())
  return response.data.map((row: any[]) => {
    const obj: any = {}
    columns.forEach((colName: string, index: number) => {
      obj[colName] = row[index]
    })
    return obj
  })
}
