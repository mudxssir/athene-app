import { fetchRedshiftTables } from './tables-fetcher'
import { redshiftSearch } from './searcher'
import { FetchedChunk } from '../base'

export async function redshiftFetcher(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  return fetchRedshiftTables(connectionId, orgId)
}

export { redshiftSearch }
