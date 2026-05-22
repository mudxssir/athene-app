import { fetchPowerBIContent } from './reports-fetcher'
import { powerbiSearch } from './searcher'
import type { FetchedChunk } from '../base'
import type { SyncConfig } from '../sync-config'

export async function powerbiFetcher(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig
): Promise<FetchedChunk[]> {
  return fetchPowerBIContent(connectionId, orgId, syncConfig)
}

export { powerbiSearch }
