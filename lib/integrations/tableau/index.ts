import { fetchTableauWorkbooks } from './workbooks-fetcher'
import { tableauSearch } from './searcher'
import { FetchedChunk } from '../base'

export async function tableauFetcher(connectionId: string, orgId: string): Promise<FetchedChunk[]> {
  return fetchTableauWorkbooks(connectionId, orgId)
}

export { tableauSearch }
