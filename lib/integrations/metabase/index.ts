import { fetchMetabaseContent } from './cards-fetcher'
import { metabaseSearch } from './searcher'
import { FetchedChunk } from '../base'

export async function metabaseFetcher(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  return fetchMetabaseContent(connectionId, orgId)
}

export { metabaseSearch }
