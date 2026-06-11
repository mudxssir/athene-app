import { notionFetch } from './client'
import { FetchedChunk } from '../base'

export async function notionSearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const searchResults = await notionFetch(connectionId, orgId, '/search', {
    query,
    filter: {
      property: 'object',
      value: 'page' // Search pages primarily
    },
    page_size: 10
  })

  const chunks: FetchedChunk[] = []
  
  for (const page of searchResults.results) {
    if (page.object !== 'page') continue

    // Fetch real page content — was a dev stub before
    const content = await fetchPageContent(connectionId, orgId, page.id)
    
    chunks.push({
      chunk_id: `notion_search_${page.id}`,
      title: getPageTitle(page),
      content,
      source_url: page.url,
      shape: 'prose' as const,
      metadata: {
        provider: 'notion',
        resource_type: 'page',
        last_modified: page.last_edited_time
      }
    })
  }

  return chunks
}

/**
 * Fetches a page's block children and converts them to plain text.
 * Accepts an optional depth limit to prevent unbounded recursion on
 * deeply nested pages.
 */
async function fetchPageContent(
  connectionId: string,
  orgId: string,
  blockId: string,
  depth: number = 0
): Promise<string> {
  // Guard against pathological nesting (e.g. infinite toggle loops)
  if (depth > 10) return ''

  let content = ''
  let hasMore = true
  let startCursor: string | undefined = undefined

  while (hasMore) {
    const url = `/blocks/${blockId}/children${startCursor ? `?start_cursor=${startCursor}` : ''}`
    const response = await notionFetch(connectionId, orgId, url)

    for (const block of response.results) {
      content += await blockToText(connectionId, orgId, block, depth)
    }

    hasMore = response.has_more
    startCursor = response.next_cursor
  }

  return content
}

async function blockToText(
  connectionId: string,
  orgId: string,
  block: any,
  depth: number
): Promise<string> {
  let text = ''
  const type = block.type
  const blockData = block[type]

  if (!blockData || !blockData.rich_text) {
    if (block.has_children) {
      return await fetchPageContent(connectionId, orgId, block.id, depth + 1)
    }
    return ''
  }

  const plainText = blockData.rich_text.map((t: any) => t.plain_text).join('')

  switch (type) {
    case 'paragraph':           text = plainText + '\n\n'; break
    case 'heading_1':           text = '# ' + plainText + '\n\n'; break
    case 'heading_2':           text = '## ' + plainText + '\n\n'; break
    case 'heading_3':           text = '### ' + plainText + '\n\n'; break
    case 'bulleted_list_item':  text = '- ' + plainText + '\n'; break
    case 'numbered_list_item':  text = '1. ' + plainText + '\n'; break
    case 'to_do':               text = `[${blockData.checked ? 'x' : ' '}] ` + plainText + '\n'; break
    case 'code':                text = '```' + (blockData.language || '') + '\n' + plainText + '\n```\n\n'; break
    case 'quote':               text = '> ' + plainText + '\n\n'; break
    default:                    text = plainText + '\n'
  }

  if (block.has_children) {
    text += await fetchPageContent(connectionId, orgId, block.id, depth + 1)
  }

  return text
}

function getPageTitle(page: any): string {
  const titleProp = page.properties.title || page.properties.Name || Object.values(page.properties).find((p: any) => p.type === 'title')
  if (titleProp && titleProp.title && titleProp.title.length > 0) {
    return titleProp.title.map((t: any) => t.plain_text).join('')
  }
  return 'Untitled'
}
