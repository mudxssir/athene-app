import { fetchLookerContent } from './looks-fetcher'
import { lookerSearch } from './searcher'
import { FetchedChunk } from '../base'

export async function lookerFetcher(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  return fetchLookerContent(connectionId, orgId)
}

export { lookerSearch }
