// SERVICE-ROLE JUSTIFICATION: connector sync writes (documents/connections)
// run as a background ingest job with no user RLS context. Frozen connector
// per REFOCUS §3.4 — not in active tool registry.
import { supabaseAdmin }           from '@/lib/supabase/server'
import { fetchHubSpotContacts }    from '@/lib/integrations/hubspot/contacts-fetcher'
import { fetchHubSpotCompanies }   from '@/lib/integrations/hubspot/companies-fetcher'
import { fetchHubSpotDeals }       from '@/lib/integrations/hubspot/deals-fetcher'
import { fetchHubSpotNotes }       from '@/lib/integrations/hubspot/notes-fetcher'
import { indexDocuments }           from '@/lib/integrations/indexing'
import type { RLSContext }         from '@/lib/supabase/rls-client'
import type { FetchedChunk }       from '@/lib/integrations/base'
import type { Visibility }         from '@/lib/knowledge-graph/types'

export interface NangoHubSpotInput {
  orgId:          string
  connectionId:   string
  dbConnectionId: string
  deptId?:        string | null
  ownerUserId?:   string | null
  visibility:     Visibility
  rlsContext?:    RLSContext
}

export interface NangoHubSpotResult {
  indexed: number
  skipped: number
  failed:  number
}

export async function runHubSpotIndexPipeline(
  input: NangoHubSpotInput
): Promise<NangoHubSpotResult> {
  const {
    orgId, connectionId, dbConnectionId,
    deptId = null, ownerUserId = null, visibility, rlsContext,
  } = input

  const [contacts, companies, deals, notes] = await Promise.all([
    fetchHubSpotContacts(connectionId, orgId),
    fetchHubSpotCompanies(connectionId, orgId),
    fetchHubSpotDeals(connectionId, orgId),
    fetchHubSpotNotes(connectionId, orgId),
  ])

  const allChunks: FetchedChunk[] = [...contacts, ...companies, ...deals, ...notes]

  const { indexed, errors } = await indexDocuments(allChunks, orgId, connectionId, deptId)

  return { indexed, skipped: 0, failed: errors }
}