import { getRedshiftCredentials, redshiftQuery } from './client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'

const TABLE_IDENT = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/

export async function redshiftSearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const creds = await getRedshiftCredentials(connectionId, orgId)
  const chunks: FetchedChunk[] = []

  if (creds.allowlist.length === 0) return chunks

  for (const tableFullName of creds.allowlist.slice(0, 5)) {
    if (!TABLE_IDENT.test(tableFullName)) continue

    try {
      // Discover text columns to search
      const descRows = await redshiftQuery(
        creds,
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema || '.' || table_name = '${tableFullName.replace(/'/g, "''")}'
           AND data_type IN ('character varying','text','character','varchar','bpchar')
         LIMIT 10`
      )
      const textCols = descRows.map((r) => r.column_name).filter(Boolean)
      if (textCols.length === 0) continue

      const safeQuery = query.replace(/'/g, "''").slice(0, 200)
      const whereClause = textCols.map((c) => `${c} ILIKE '%${safeQuery}%'`).join(' OR ')
      const rows = await redshiftQuery(creds, `SELECT * FROM ${tableFullName} WHERE ${whereClause} LIMIT 10`)

      for (let i = 0; i < rows.length; i++) {
        const content = Object.entries(rows[i]).map(([k, v]) => `${k}: ${v}`).join(', ')
        const tableName = tableFullName.split('.').pop() ?? tableFullName
        chunks.push({
          chunk_id: `redshift_search_${tableFullName.replace(/\./g, '_')}_${i}`,
          title: `Redshift result: ${tableName}`,
          content,
          source_url: `redshift://${creds.clusterId}/${creds.database}/${tableFullName}`,
          shape: 'tabular' as const,
          metadata: {
            provider: 'redshift',
            resource_type: 'search_result',
            cluster_id: creds.clusterId,
            table: tableFullName,
          },
        })
      }
    } catch (err) {
      logger.error({ err }, `[redshift] Search failed for ${tableFullName}`)
    }
  }

  return chunks
}
