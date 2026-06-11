import { snowflakeFetch } from './client'
import { parseSnowflakeRows } from './schema-fetcher'
import { logger } from '@/lib/logger'
import { getConnectionMetadata } from '@/lib/nango/client'
import { FetchedChunk } from '../base'

export async function snowflakeSearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const connection = await getConnectionMetadata(connectionId, 'snowflake', orgId)
  const allowlist = connection.allowlist as string[] | undefined

  if (!allowlist || allowlist.length === 0) {
    return []
  }

  const chunks: FetchedChunk[] = []

  const identifierRegex = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/

  for (const tableFullName of allowlist) {
    if (!identifierRegex.test(tableFullName)) continue
    try {
      // Find columns that are strings to search with LIKE
      const describeRes = await snowflakeFetch(connectionId, orgId, `DESCRIBE TABLE ${tableFullName}`)
      const columns = parseSnowflakeRows(describeRes)
      const stringCols = columns
        .filter((col: any) => col.type.toLowerCase().includes('string') || col.type.toLowerCase().includes('text') || col.type.toLowerCase().includes('varchar'))
        .map((col: any) => col.name)

      if (stringCols.length === 0) continue

      // Fix: parameterized LIKE queries — user input is never interpolated into SQL.
      // Snowflake SQL API accepts a `binds` array; each '?' placeholder is bound server-side.
      const binds: string[] = stringCols.map(() => `%${query}%`)
      const whereClause = stringCols.map((col: string) => `${col} LIKE ?`).join(' OR ')
      const response = await snowflakeFetch(connectionId, orgId, `SELECT * FROM ${tableFullName} WHERE ${whereClause} LIMIT 10`, binds)
      const rows = parseSnowflakeRows(response)
      
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const content = Object.entries(row)
          .map(([col, val]) => `${col}: ${val}`)
          .join(', ')

        const parts = tableFullName.split('.')
        const tableName = parts[parts.length - 1]

        chunks.push({
          chunk_id: `snowflake_search_${tableFullName}_${i}`,
          title: `Result from ${tableName}`,
          content: content,
          source_url: `snowflake://${tableFullName}`,
          shape: 'tabular' as const,
          metadata: {
            provider: 'snowflake',
            resource_type: 'search_result',
            table: tableFullName 
          }
        })
      }
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, `Error searching table ${tableFullName}:`)
    }
  }

  return chunks
}
