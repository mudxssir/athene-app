import { fetchSnowflakeSamples } from './sample-fetcher'
import { snowflakeSearch } from './searcher'
import { FetchedChunk } from '../base'

export async function snowflakeFetcher(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  return await fetchSnowflakeSamples(connectionId, orgId)
}
