// ============================================================
// HubSpot Notes fetcher (ATH-67)
//
// GET /crm/v3/objects/notes with cursor-based pagination.
// Returns FetchedChunk[] — content is ephemeral, never stored.
// ============================================================

import { hubspotFetch } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

interface HubSpotNote {
  id: string
  properties: {
    hs_note_body: string | null
    hs_timestamp: string | null
    hubspot_owner_id: string | null
  }
}

interface HubSpotResponse {
  results: HubSpotNote[]
  paging?: { next?: { after: string } }
}

export async function fetchHubSpotNotes(
  connectionId: string,
  orgId: string
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []
  let after: string | null = null

  while (true) {
    const qs = new URLSearchParams({
      limit: '100',
      properties: 'hs_note_body,hs_timestamp,hubspot_owner_id',
      ...(after ? { after } : {}),
    })

    const data = await hubspotFetch(connectionId, `/crm/v3/objects/notes?${qs}`, orgId) as HubSpotResponse

    for (const record of data.results) {
      const p         = record.properties
      const timestamp = p.hs_timestamp ? new Date(p.hs_timestamp).toISOString() : null

      chunks.push({
        chunk_id:   `hs-note-${record.id}`,
        title:      `Note ${timestamp ? `— ${timestamp}` : record.id}`,
        content: [
          `Note ID: ${record.id}`,
          timestamp          ? `Timestamp: ${timestamp}`         : null,
          p.hubspot_owner_id ? `Owner ID: ${p.hubspot_owner_id}` : null,
          p.hs_note_body     ? `Body:\n${p.hs_note_body}`        : null,
        ].filter(Boolean).join('\n'),
        source_url: `https://app.hubspot.com/contacts/note/${record.id}`,
        shape: 'prose' as const,
        metadata: {
          provider:    'hubspot',
          resource_type: 'notes',
          id:          record.id,
          timestamp:   timestamp ?? null,
          owner_id:    p.hubspot_owner_id ?? null,
        },
      })
    }

    after = data.paging?.next?.after ?? null
    if (!after) break
  }

  return chunks
}