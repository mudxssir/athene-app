import { fetchBigQueryDatasets } from './datasets-fetcher'
import { bigquerySearch } from './searcher'
import { FetchedChunk } from '../base'

export async function bigqueryFetcher(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  return fetchBigQueryDatasets(connectionId, orgId)
}

export { bigquerySearch }
