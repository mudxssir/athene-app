import { fetchAllPages } from './pages-fetcher'
import { fetchAllDatabases } from './databases-fetcher'
import { notionSearch } from './searcher'
import { FetchedChunk } from '../base'

export async function notionFetcher(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  const pages = await fetchAllPages(connectionId, orgId)
  const databases = await fetchAllDatabases(connectionId, orgId)
  return [...pages, ...databases]
}

export const notionSearcher = notionSearch
