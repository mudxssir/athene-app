// ============================================================
// bi-chunking.ts — Semantic chunking for BI / tabular data
//
// For SQL tables, raw row-dumps produce semantically empty
// embeddings. Instead we generate three chunk types per table:
//
//   1. Stats chunk  — schema + column statistics (row count,
//      min/max/avg/sum for numerics, top-N for categoricals,
//      date ranges). Answers virtually all aggregate BI questions.
//
//   2. Sample chunk — representative row sample, grouped by the
//      most cardinal categorical column for coherent context.
//
//   3. Aggregation chunk — pre-computed GROUP BY results for
//      every numeric × categorical dimension pair (top 2 dims).
//      Directly answers "revenue by region" style queries.
//
// These helpers are provider-agnostic; Snowflake, BigQuery, and
// Redshift all call them with the same inputs.
// ============================================================

import type { FetchedChunk } from './base'
import type { KGNode, KGEdge, Visibility } from '@/lib/knowledge-graph/types'
import { TABULAR_PII_MASKING } from '@/lib/config/feature-flags'

// ---- PII masking (P4-3) ---------------------------------------

/** Columns per group when rendering a wide sample chunk (table-name header re-emitted per group). */
const WIDE_TABLE_COLUMN_GROUP = 30

// Order matters: email first, then SSN (9 digits, 3-2-4) before phone (10 digits)
// so a 3-2-4 SSN is never half-matched by the phone pattern.
const PII_PATTERNS: RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,        // email
  /\b\d{3}-\d{2}-\d{4}\b/g,                                  // SSN (3-2-4)
  // phone: optional country code, optional area-code parens, 3-3-4 with any of
  // space/dot/dash separators. No leading \b (so `(415) …` parens-form matches).
  /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
]

/**
 * Mask email / SSN / phone tokens in a rendered cell value → `***`.
 * No-op unless TABULAR_PII_MASKING is on. Applied only to rendered raw values
 * (sample rows, categorical top-values); statistical aggregates are untouched.
 */
export function maskPII(value: string): string {
  if (!TABULAR_PII_MASKING || !value) return value
  let out = value
  for (const re of PII_PATTERNS) out = out.replace(re, '***')
  return out
}

// ---- SyncConfig -----------------------------------------------

export interface SyncConfig {
  max_rows_per_table: number
  sample_rows: number
  enable_stats: boolean
  enable_aggregations: boolean
  stats_categorical_limit: number
  incremental: boolean
}

const DEFAULTS: SyncConfig = {
  max_rows_per_table: 10_000,
  sample_rows: 50,
  enable_stats: true,
  enable_aggregations: true,
  stats_categorical_limit: 20,
  incremental: true,
}

export function resolveSyncConfig(raw: Record<string, unknown> | null | undefined): SyncConfig {
  if (!raw) return { ...DEFAULTS }
  return {
    max_rows_per_table: (raw.max_rows_per_table as number) ?? DEFAULTS.max_rows_per_table,
    sample_rows:        (raw.sample_rows as number)        ?? DEFAULTS.sample_rows,
    enable_stats:       (raw.enable_stats as boolean)      ?? DEFAULTS.enable_stats,
    enable_aggregations:(raw.enable_aggregations as boolean) ?? DEFAULTS.enable_aggregations,
    stats_categorical_limit: (raw.stats_categorical_limit as number) ?? DEFAULTS.stats_categorical_limit,
    incremental:        (raw.incremental as boolean)       ?? DEFAULTS.incremental,
  }
}

// ---- Column statistics types ----------------------------------

export interface ColumnSchema {
  name: string
  type: string  // raw provider type string
}

export interface NumericStat {
  col: string
  min: string
  max: string
  avg: string
  sum: string
}

export interface CategoricalStat {
  col: string
  distinct: number
  topValues: { value: string; count: string }[]
}

export interface DateStat {
  col: string
  min: string
  max: string
}

export interface TableStats {
  tableName: string
  rowCount: number
  schema: ColumnSchema[]
  numeric: NumericStat[]
  categorical: CategoricalStat[]
  dates: DateStat[]
}

export interface AggregationResult {
  dimension: string
  metric: string
  rows: { dimValue: string; metricValue: string }[]
}

// ---- Column type classification --------------------------------

const NUMERIC_TYPES = new Set([
  'number', 'numeric', 'decimal', 'float', 'double', 'real', 'integer', 'int',
  'bigint', 'smallint', 'tinyint', 'byteint', 'fixed', 'float4', 'float8',
  'int2', 'int4', 'int8', 'int16', 'int32', 'int64', 'money', 'currency',
])

const DATE_TYPES = new Set([
  'date', 'datetime', 'timestamp', 'timestamp_ntz', 'timestamp_tz',
  'timestamp_ltz', 'timestamptz', 'time', 'timetz',
])

const TEXT_TYPES = new Set([
  'text', 'string', 'varchar', 'char', 'character', 'nvarchar', 'nchar',
  'bpchar', 'character varying', 'name', 'enum',
])

export function classifyColumn(type: string): 'numeric' | 'categorical' | 'date' | 'other' {
  const t = type.toLowerCase().replace(/\(.*\)/, '').trim()
  if (DATE_TYPES.has(t) || t.startsWith('timestamp') || t.startsWith('date')) return 'date'
  if (NUMERIC_TYPES.has(t) || t.startsWith('number') || t.startsWith('numeric') || t.startsWith('decimal') || t.startsWith('float') || t.startsWith('double') || t.startsWith('int')) return 'numeric'
  if (TEXT_TYPES.has(t) || t.startsWith('varchar') || t.startsWith('char') || t.startsWith('nvar')) return 'categorical'
  return 'other'
}

// ---- Chunk builders -------------------------------------------

export function buildStatsChunk(
  tableFullName: string,
  stats: TableStats,
  provider: string,
  sourceUrl: string,
): FetchedChunk {
  const lines: string[] = [`Table: ${tableFullName} (${stats.rowCount.toLocaleString()} rows)`]

  if (stats.schema.length > 0) {
    lines.push('Columns:')
    for (const col of stats.schema) {
      const kind = classifyColumn(col.type)
      const numStat = stats.numeric.find((n) => n.col === col.name)
      const catStat = stats.categorical.find((c) => c.col === col.name)
      const dateStat = stats.dates.find((d) => d.col === col.name)

      let detail = col.type
      if (numStat) {
        const parts: string[] = []
        if (numStat.min !== '' && numStat.max !== '') parts.push(`range: ${numStat.min}–${numStat.max}`)
        if (numStat.avg !== '') parts.push(`avg: ${numStat.avg}`)
        if (numStat.sum !== '') parts.push(`total: ${numStat.sum}`)
        if (parts.length) detail += ` — ${parts.join(', ')}`
      } else if (catStat) {
        // P4-3: top categorical values are raw cell values — mask PII here too
        // (the count distribution is unaffected; only the value label is masked).
        const topStr = catStat.topValues
          .slice(0, 5)
          .map(({ value, count }) => `${maskPII(value)} (${count})`)
          .join(', ')
        detail += ` — ${catStat.distinct} distinct values`
        if (topStr) detail += `: ${topStr}`
      } else if (dateStat) {
        detail += ` — range: ${dateStat.min} to ${dateStat.max}`
      }

      lines.push(`  ${col.name.padEnd(20)} ${detail}`)
    }
  }

  const content = lines.join('\n')

  return {
    chunk_id: `${provider}_stats_${tableFullName.replace(/[^A-Za-z0-9_]/g, '_')}`,
    title: `${provider.toUpperCase()}: ${tableFullName} — Schema & Statistics`,
    content,
    source_url: sourceUrl,
    shape: 'tabular' as const,
    metadata: {
      provider,
      resource_type: 'table_stats',
      table: tableFullName,
      row_count: String(stats.rowCount),
      // P4-1 (D2): structured column schema so the builder can reconstruct
      // schema entities deterministically (no LLM). Small, structured — not
      // content. Consumed by buildSchemaEntityGraph at KG-build time.
      schema: stats.schema.map((c) => ({ name: c.name, type: c.type })),
    },
  }
}

export function buildSampleChunk(
  tableFullName: string,
  schema: ColumnSchema[],
  rows: Record<string, string>[],
  provider: string,
  sourceUrl: string,
): FetchedChunk {
  if (rows.length === 0) {
    return {
      chunk_id: `${provider}_sample_${tableFullName.replace(/[^A-Za-z0-9_]/g, '_')}`,
      title: `${provider.toUpperCase()}: ${tableFullName} — Sample Rows`,
      content: `Table ${tableFullName} — no rows returned`,
      source_url: sourceUrl,
      shape: 'tabular' as const,
      metadata: { provider, resource_type: 'table_sample', table: tableFullName },
    }
  }

  // P4-3: render a row as `k: v, …` with PII-masked values. For wide tables
  // (> WIDE_TABLE_COLUMN_GROUP columns) the row is segmented into column groups,
  // each prefixed with a table-name + column-range header so every group is
  // self-describing (header re-emit) and no single 200-column blob is produced.
  const colNames = schema.map((c) => c.name)
  const wide = colNames.length > WIDE_TABLE_COLUMN_GROUP

  const renderRow = (row: Record<string, string>): string => {
    if (!wide) {
      return Object.entries(row).map(([k, v]) => `${k}: ${maskPII(v)}`).join(', ')
    }
    const parts: string[] = []
    for (let g = 0; g < colNames.length; g += WIDE_TABLE_COLUMN_GROUP) {
      const group = colNames.slice(g, g + WIDE_TABLE_COLUMN_GROUP)
      const kv = group.map((c) => `${c}: ${maskPII(row[c] ?? '')}`).join(', ')
      parts.push(`[${tableFullName} cols ${g + 1}-${g + group.length}] ${kv}`)
    }
    return parts.join('\n')
  }

  // Detect primary grouping dimension: most cardinal categorical column
  const primaryDim = detectPrimaryDimension(schema, rows)

  let content: string
  if (primaryDim) {
    // Group rows by primary dimension value, show a few rows per group
    const groups = new Map<string, Record<string, string>[]>()
    for (const row of rows) {
      const key = row[primaryDim] ?? 'NULL'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }
    const blocks: string[] = []
    for (const [dimVal, groupRows] of Array.from(groups.entries()).slice(0, 10)) {
      blocks.push(`--- ${primaryDim}: ${maskPII(dimVal)} ---`)
      for (const row of groupRows.slice(0, 3)) {
        blocks.push(renderRow(row))
      }
    }
    content = blocks.join('\n')
  } else {
    content = rows.slice(0, 50).map(renderRow).join('\n')
  }

  return {
    chunk_id: `${provider}_sample_${tableFullName.replace(/[^A-Za-z0-9_]/g, '_')}`,
    title: `${provider.toUpperCase()}: ${tableFullName} — Sample Rows`,
    content,
    source_url: sourceUrl,
    shape: 'tabular' as const,
    metadata: { provider, resource_type: 'table_sample', table: tableFullName },
  }
}

export function buildAggregationChunk(
  tableFullName: string,
  aggResults: AggregationResult[],
  provider: string,
  sourceUrl: string,
): FetchedChunk {
  if (aggResults.length === 0) {
    return {
      chunk_id: `${provider}_agg_${tableFullName.replace(/[^A-Za-z0-9_]/g, '_')}`,
      title: `${provider.toUpperCase()}: ${tableFullName} — Aggregations`,
      content: `Table ${tableFullName} — no aggregations available`,
      source_url: sourceUrl,
      shape: 'tabular' as const,
      metadata: { provider, resource_type: 'table_aggregations', table: tableFullName },
    }
  }

  const lines: string[] = [`${tableFullName} — Pre-computed Aggregations`]
  for (const agg of aggResults) {
    const rowsStr = agg.rows
      .slice(0, 10)
      .map(({ dimValue, metricValue }) => `${dimValue}: ${metricValue}`)
      .join(', ')
    lines.push(`${agg.metric} by ${agg.dimension}: ${rowsStr}`)
  }

  return {
    chunk_id: `${provider}_agg_${tableFullName.replace(/[^A-Za-z0-9_]/g, '_')}`,
    title: `${provider.toUpperCase()}: ${tableFullName} — Aggregations`,
    content: lines.join('\n'),
    source_url: sourceUrl,
    shape: 'tabular' as const,
    metadata: { provider, resource_type: 'table_aggregations', table: tableFullName },
  }
}

// ---- KG schema entity extraction (deterministic, no LLM) ------

export function extractSchemaEntities(
  tableFullName: string,
  stats: TableStats,
  orgId: string,
  departmentId: string | null,
  visibility: Visibility,
  documentId: string,
): { nodes: KGNode[]; edges: KGEdge[] } {
  const nodes: KGNode[] = []
  const edges: KGEdge[] = []
  const deptIds = departmentId ? [departmentId] : []

  const tableNode: KGNode = {
    org_id: orgId,
    label: tableFullName,
    entity_type: 'service',    // closest built-in type for a data table
    department_ids: deptIds,
    visibility,
    source_documents: [documentId],
    description: `Data table: ${tableFullName} (${stats.rowCount.toLocaleString()} rows)`,
  }
  nodes.push(tableNode)

  for (const col of stats.schema) {
    const kind = classifyColumn(col.type)
    if (kind === 'numeric') {
      const metricNode: KGNode = {
        org_id: orgId,
        label: `${tableFullName}.${col.name}`,
        entity_type: 'concept',
        department_ids: deptIds,
        visibility,
        source_documents: [documentId],
        description: `Numeric metric column: ${col.name} in ${tableFullName}`,
      }
      nodes.push(metricNode)
      edges.push({
        org_id: orgId,
        source_label: tableFullName,
        source_entity_type: 'service',
        target_label: metricNode.label,
        target_entity_type: 'concept',
        relation: 'FEEDS',
        provenance: 'EXTRACTED',
        confidence: 1.0,
        source_document: documentId,
        department_id: departmentId,
        visibility,
      })
    } else if (kind === 'categorical') {
      const dimNode: KGNode = {
        org_id: orgId,
        label: `${tableFullName}.${col.name}`,
        entity_type: 'concept',
        department_ids: deptIds,
        visibility,
        source_documents: [documentId],
        description: `Categorical dimension column: ${col.name} in ${tableFullName}`,
      }
      nodes.push(dimNode)
      edges.push({
        org_id: orgId,
        source_label: tableFullName,
        source_entity_type: 'service',
        target_label: dimNode.label,
        target_entity_type: 'concept',
        relation: 'PART_OF',
        provenance: 'EXTRACTED',
        confidence: 1.0,
        source_document: documentId,
        department_id: departmentId,
        visibility,
      })
    }
  }

  return { nodes, edges }
}

/** Resource types whose chunks are fully deterministic (Tier C — no LLM). */
export const TABULAR_RESOURCE_TYPES = new Set([
  'table_stats',
  'table_sample',
  'table_aggregations',
])

interface SchemaChunkLike {
  metadata?: Record<string, unknown> | null
}

/**
 * P4-1 (D2): deterministic KG path for tabular documents. Scans a document's
 * chunks for `table_stats` chunks (which carry `table` + `schema` in metadata,
 * emitted by buildStatsChunk) and produces schema entities via
 * extractSchemaEntities — table → service node, numeric cols → metric concepts
 * (FEEDS), categorical cols → dimension concepts (PART_OF), all EXTRACTED/1.0,
 * ZERO LLM calls. Returns empty when no stats chunk is present.
 *
 * Mirrors buildStructuredLinkGraph / buildStructuredOwnerGraph: a pure,
 * deterministic node/edge producer the builder merges alongside LLM output.
 */
export function buildSchemaEntityGraph(
  chunks: SchemaChunkLike[],
  orgId: string,
  departmentId: string | null,
  visibility: Visibility,
  documentId: string,
): { nodes: KGNode[]; edges: KGEdge[] } {
  const nodes: KGNode[] = []
  const edges: KGEdge[] = []

  for (const chunk of chunks) {
    const meta = chunk.metadata
    if (!meta || meta.resource_type !== 'table_stats') continue

    const tableFullName = typeof meta.table === 'string' ? meta.table : ''
    const rawSchema = Array.isArray(meta.schema) ? meta.schema : []
    if (!tableFullName || rawSchema.length === 0) continue

    const schema: ColumnSchema[] = rawSchema
      .filter((c): c is { name: string; type: string } =>
        !!c && typeof (c as ColumnSchema).name === 'string' && typeof (c as ColumnSchema).type === 'string')
      .map((c) => ({ name: c.name, type: c.type }))
    if (schema.length === 0) continue

    const rowCount = Number(meta.row_count ?? 0) || 0

    // extractSchemaEntities only reads stats.rowCount + stats.schema; the other
    // TableStats fields are unused here, so a minimal object is sufficient.
    const stats: TableStats = {
      tableName: tableFullName,
      rowCount,
      schema,
      numeric: [],
      categorical: [],
      dates: [],
    }
    const sub = extractSchemaEntities(tableFullName, stats, orgId, departmentId, visibility, documentId)
    nodes.push(...sub.nodes)
    edges.push(...sub.edges)
  }

  return { nodes, edges }
}

// ---- Internal helper ------------------------------------------

function detectPrimaryDimension(
  schema: ColumnSchema[],
  rows: Record<string, string>[],
): string | null {
  if (rows.length === 0) return null
  const categoricals = schema.filter((c) => classifyColumn(c.type) === 'categorical')
  if (categoricals.length === 0) return null

  // Pick the categorical column with the most distinct values (but not > 80% unique, which would be an ID)
  let best: string | null = null
  let bestScore = 0

  for (const col of categoricals) {
    const distinct = new Set(rows.map((r) => r[col.name])).size
    const ratio = distinct / rows.length
    // Ideal: enough diversity to group by (>2 distinct) but not an ID (< 80% unique)
    if (distinct > 2 && ratio < 0.8) {
      const score = distinct
      if (score > bestScore) {
        bestScore = score
        best = col.name
      }
    }
  }

  return best
}
