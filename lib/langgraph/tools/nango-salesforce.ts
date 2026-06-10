// SERVICE-ROLE JUSTIFICATION: connector sync writes (documents/connections)
// run as a background ingest job with no user RLS context. Frozen connector
// per REFOCUS §3.4 — not in active tool registry.
import { supabaseAdmin }                from '@/lib/supabase/server'
import { fetchSalesforceAccounts }      from '@/lib/integrations/salesforce/accounts-fetcher'
import { fetchSalesforceOpportunities } from '@/lib/integrations/salesforce/opportunities-fetcher'
import { fetchSalesforceCases }         from '@/lib/integrations/salesforce/cases-fetcher'
import { indexDocuments }               from '@/lib/integrations/indexing'
import type { RLSContext }              from '@/lib/supabase/rls-client'
import type { FetchedChunk }            from '@/lib/integrations/base'
import type { Visibility }              from '@/lib/knowledge-graph/types'

export interface NangoSalesforceInput {
  orgId:          string
  connectionId:   string
  dbConnectionId: string
  instanceUrl:    string
  deptId?:        string | null
  ownerUserId?:   string | null
  visibility:     Visibility
  rlsContext?:    RLSContext
}

export interface NangoSalesforceResult {
  indexed: number
  skipped: number
  failed:  number
}

export async function runSalesforceIndexPipeline(
  input: NangoSalesforceInput
): Promise<NangoSalesforceResult> {
  const {
    orgId, connectionId, dbConnectionId, instanceUrl,
    deptId = null, ownerUserId = null, visibility, rlsContext,
  } = input

  const [accounts, opportunities, cases] = await Promise.all([
    fetchSalesforceAccounts(connectionId, instanceUrl, orgId),
    fetchSalesforceOpportunities(connectionId, instanceUrl, orgId),
    fetchSalesforceCases(connectionId, instanceUrl, orgId),
  ])

  const allChunks: FetchedChunk[] = [...accounts, ...opportunities, ...cases]

  const { indexed, errors } = await indexDocuments(allChunks, orgId, connectionId, deptId)

  return { indexed, skipped: 0, failed: errors }
}