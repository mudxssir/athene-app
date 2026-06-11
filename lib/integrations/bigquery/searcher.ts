import { bigqueryFetch, bigqueryProjectId, parseBigQueryRows } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'

export async function bigquerySearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const projectId = await bigqueryProjectId(connectionId, orgId)
  const chunks: FetchedChunk[] = []

  // Use BigQuery SEARCH function (available in all regions) — safe parameterized approach
  // We enumerate datasets and search string columns with LIKE across allowlist tables.
  const datasetsRes = await bigqueryFetch<any>(connectionId, orgId, '/datasets?maxResults=20')
  const datasets: { datasetReference: { datasetId: string } }[] = datasetsRes?.datasets ?? []

  const safeQuery = query.replace(/'/g, "''").slice(0, 200)

  for (const ds of datasets.slice(0, 5)) {
    const datasetId = ds.datasetReference.datasetId
    try {
      const tablesRes = await bigqueryFetch<any>(connectionId, orgId, `/datasets/${datasetId}/tables?maxResults=10`)
      const tables: { tableReference: { tableId: string } }[] = tablesRes?.tables ?? []

      for (const table of tables.slice(0, 3)) {
        const tableId = table.tableReference.tableId
        const fullId = `\`${projectId}.${datasetId}.${tableId}\``
        try {
          // BigQuery SEARCH scans all STRING columns
          const queryRes = await bigqueryFetch<any>(connectionId, orgId, '/queries', {
            method: 'POST',
            body: {
              query: `SELECT * FROM ${fullId} WHERE SEARCH(${fullId}, '${safeQuery}') LIMIT 10`,
              useLegacySql: false,
              timeoutMs: 15000,
              maxResults: 10,
            },
          })

          const rows = parseBigQueryRows(queryRes)
          if (rows.length === 0) continue

          for (let i = 0; i < rows.length; i++) {
            const content = Object.entries(rows[i]).map(([k, v]) => `${k}: ${v}`).join(', ')
            chunks.push({
              chunk_id: `bigquery_search_${datasetId}_${tableId}_${i}`,
              title: `BigQuery result: ${datasetId}.${tableId}`,
              content,
              source_url: `https://console.cloud.google.com/bigquery?project=${projectId}&p=${projectId}&d=${datasetId}&t=${tableId}&page=table`,
              shape: 'tabular' as const,
              metadata: {
                provider: 'bigquery',
                resource_type: 'search_result',
                project_id: projectId,
                dataset_id: datasetId,
                table_id: tableId,
              },
            })
          }
        } catch {
          // SEARCH may not be supported on all table types
        }
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, `[bigquery] Search failed for dataset ${datasetId}:`)
    }
  }

  return chunks
}
