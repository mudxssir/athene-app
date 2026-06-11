// ============================================================
// HubSpot Deals fetcher (ATH-67)
//
// GET /crm/v3/objects/deals with cursor-based pagination.
// Returns FetchedChunk[] — content is ephemeral, never stored.
// ============================================================

import { hubspotFetch } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

interface HubSpotDeal {
  id: string
  properties: {
    dealname: string | null
    dealstage: string | null
    pipeline: string | null
    amount: string | null
    closedate: string | null
    dealtype: string | null
    description: string | null
    hs_deal_stage_probability: string | null
    createdate: string | null
  }
}

interface HubSpotResponse {
  results: HubSpotDeal[]
  paging?: { next?: { after: string } }
}

export async function fetchHubSpotDeals(
  connectionId: string,
  orgId: string
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []
  let after: string | null = null

  while (true) {
    const qs = new URLSearchParams({
      limit: '100',
      properties: 'dealname,dealstage,pipeline,amount,closedate,dealtype,description,hs_deal_stage_probability,createdate',
      ...(after ? { after } : {}),
    })

    const data = await hubspotFetch(connectionId, `/crm/v3/objects/deals?${qs}`, orgId) as HubSpotResponse

    for (const record of data.results) {
      const p    = record.properties
      const name = p.dealname ?? 'Unnamed Deal'

      const amount = p.amount ? `$${Number(p.amount).toLocaleString()}` : null
      const probability = p.hs_deal_stage_probability
        ? `${Math.round(Number(p.hs_deal_stage_probability) * 100)}%`
        : null
      const closeDate = p.closedate ? new Date(p.closedate).toLocaleDateString() : null

      chunks.push({
        chunk_id:   `hs-deal-${record.id}`,
        title:      name,
        content: [
          `Deal: ${name}`,
          p.dealstage  ? `Stage: ${p.dealstage}`       : null,
          p.pipeline   ? `Pipeline: ${p.pipeline}`     : null,
          amount       ? `Amount: ${amount}`            : null,
          probability  ? `Win Probability: ${probability}` : null,
          closeDate    ? `Close Date: ${closeDate}`    : null,
          p.dealtype   ? `Type: ${p.dealtype}`         : null,
          p.description ? `Description: ${p.description}` : null,
        ].filter(Boolean).join('\n'),
        source_url: `https://app.hubspot.com/contacts/deal/${record.id}`,
        shape: 'record' as const,
        metadata: {
          provider:    'hubspot',
          resource_type: 'deals',
          id:          record.id,
          stage:       p.dealstage ?? null,
          pipeline:    p.pipeline ?? null,
          amount:      p.amount ?? null,
        },
      })
    }

    after = data.paging?.next?.after ?? null
    if (!after) break
  }

  return chunks
}