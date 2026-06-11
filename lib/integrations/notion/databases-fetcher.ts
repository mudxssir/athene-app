import { notionFetch } from './client'
import { FetchedChunk } from '../base'
import { type SyncConfig, getSelectedResourceIds, getExcludedResourceIds } from '../sync-config'

export async function fetchAllDatabases(connectionId: string, orgId: string, syncConfig?: SyncConfig): Promise<FetchedChunk[]> {
  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const excludedIds = syncConfig ? getExcludedResourceIds(syncConfig) : new Set<string>()

  const chunks: FetchedChunk[] = []
  let hasMore = true
  let startCursor: string | undefined = undefined

  while (hasMore) {
    // 1. Search for all databases
    const searchResults = await notionFetch(connectionId, orgId, '/search', {
      filter: {
        property: 'object',
        value: 'database'
      },
      start_cursor: startCursor
    })

    for (const db of searchResults.results) {
      if (db.object !== 'database') continue

      // ── Selective sync: skip databases not in the user's selection ──
      if (selectedIds && selectedIds.size > 0 && !selectedIds.has(db.id)) continue
      if (excludedIds.has(db.id)) continue

      const title = getDatabaseTitle(db)

      // Schema header chunk — describes the database columns/properties
      const schemaHeader = buildSchemaHeader(title, db.properties ?? {})
      chunks.push({
        chunk_id: `notion_db_schema_${db.id}`,
        title: `Database Schema: ${title}`,
        content: schemaHeader,
        source_url: db.url,
        shape: 'prose' as const,
        metadata: {
          provider: 'notion',
          resource_type: 'database_schema',
          last_modified: db.last_edited_time,
        },
      })

      // Row-data chunk — all pages/records in the database
      const content = await fetchDatabaseContent(connectionId, orgId, db.id)
      if (content.trim()) {
        chunks.push({
          chunk_id: `notion_db_${db.id}`,
          title: `Database: ${title}`,
          content,
          source_url: db.url,
          shape: 'record' as const,
          metadata: {
            provider: 'notion',
            resource_type: 'database',
            last_modified: db.last_edited_time,
          },
        })
      }
    }

    hasMore = searchResults.has_more
    startCursor = searchResults.next_cursor
  }

  return chunks
}

async function fetchDatabaseContent(connectionId: string, orgId: string, databaseId: string): Promise<string> {
  let content = ''
  let hasMore = true
  let startCursor: string | undefined = undefined

  while (hasMore) {
    const response = await notionFetch(connectionId, orgId, `/databases/${databaseId}/query`, {
      start_cursor: startCursor
    })

    for (const page of response.results) {
      content += pageToRowSummary(page) + '\n'
    }

    hasMore = response.has_more
    startCursor = response.next_cursor
  }

  return content
}

function pageToRowSummary(page: any): string {
  const properties = page.properties
  const summary: string[] = []

  for (const [name, prop] of Object.entries(properties)) {
    const value = getPropertyValue(prop)
    if (value) {
      summary.push(`${name}: ${value}`)
    }
  }

  return summary.join(' | ')
}

function getPropertyValue(prop: any): string {
  const type = prop.type
  const data = prop[type]

  switch (type) {
    case 'title':
    case 'rich_text':
      return data.map((t: any) => t.plain_text).join('')
    case 'number':
      return data?.toString() || ''
    case 'select':
      return data?.name || ''
    case 'multi_select':
      return data.map((s: any) => s.name).join(', ')
    case 'date':
      return data ? `${data.start}${data.end ? ` to ${data.end}` : ''}` : ''
    case 'checkbox':
      return data ? 'Yes' : 'No'
    case 'url':
      return data || ''
    case 'email':
      return data || ''
    case 'phone_number':
      return data || ''
    case 'people':
      return data.map((p: any) => p.name || p.id).join(', ')
    default:
      return ''
  }
}

function getDatabaseTitle(db: any): string {
  if (db.title && db.title.length > 0) {
    return db.title.map((t: any) => t.plain_text).join('')
  }
  return 'Untitled Database'
}

/**
 * Builds a plain-text schema description from a Notion database's properties map.
 * Gives the embedding model enough context to match queries like "what fields does
 * the CRM database have?" without needing to scan all row content.
 */
function buildSchemaHeader(dbTitle: string, properties: Record<string, any>): string {
  const lines: string[] = [`Notion Database: ${dbTitle}`, 'Columns:']

  for (const [propName, propDef] of Object.entries(properties)) {
    const type: string = propDef?.type ?? 'unknown'
    let detail = type

    // For select/multi_select, list the available options
    if ((type === 'select' || type === 'multi_select') && propDef[type]?.options) {
      const options: string[] = (propDef[type].options as any[])
        .slice(0, 10)
        .map((o: any) => o.name)
      if (options.length > 0) {
        detail += ` (options: ${options.join(', ')})`
      }
    }

    // For relation, show target database ID
    if (type === 'relation' && propDef.relation?.database_id) {
      detail += ` → ${propDef.relation.database_id}`
    }

    // For formula, show expression
    if (type === 'formula' && propDef.formula?.expression) {
      detail += ` (formula: ${String(propDef.formula.expression).slice(0, 60)})`
    }

    lines.push(`  ${propName}: ${detail}`)
  }

  return lines.join('\n')
}
