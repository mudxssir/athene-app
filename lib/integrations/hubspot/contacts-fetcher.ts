// ============================================================
// HubSpot Contacts fetcher (ATH-67)
//
// GET /crm/v3/objects/contacts with cursor-based pagination.
// Returns FetchedChunk[] — content is ephemeral, never stored.
// ============================================================

import { hubspotFetch } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

export type { FetchedChunk }

interface HubSpotContact {
  id: string
  properties: {
    firstname: string | null
    lastname: string | null
    email: string | null
    phone: string | null
    company: string | null
    jobtitle: string | null
    lifecyclestage: string | null
    city: string | null
    country: string | null
    createdate: string | null
    lastmodifieddate: string | null
  }
}

interface HubSpotResponse {
  results: HubSpotContact[]
  paging?: { next?: { after: string } }
}

export async function fetchHubSpotContacts(
  connectionId: string,
  orgId: string
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []
  let after: string | null = null

  while (true) {
    const qs = new URLSearchParams({
      limit: '100',
      properties: 'firstname,lastname,email,phone,company,jobtitle,lifecyclestage,city,country,createdate,lastmodifieddate',
      ...(after ? { after } : {}),
    })

    const data = await hubspotFetch(connectionId, `/crm/v3/objects/contacts?${qs}`, orgId) as HubSpotResponse

    for (const record of data.results) {
      const p        = record.properties
      const fullName = [p.firstname, p.lastname].filter(Boolean).join(' ') || 'Unnamed Contact'

      const location = [p.city, p.country].filter(Boolean).join(', ') || null

      chunks.push({
        chunk_id:   `hs-contact-${record.id}`,
        title:      fullName,
        content: [
          `Contact: ${fullName}`,
          p.jobtitle       ? `Title: ${p.jobtitle}`                 : null,
          p.company        ? `Company: ${p.company}`                : null,
          p.email          ? `Email: ${p.email}`                    : null,
          p.phone          ? `Phone: ${p.phone}`                    : null,
          location         ? `Location: ${location}`                : null,
          p.lifecyclestage ? `Lifecycle Stage: ${p.lifecyclestage}` : null,
        ].filter(Boolean).join('\n'),
        source_url: `https://app.hubspot.com/contacts/contact/${record.id}`,
        shape: 'record' as const,
        metadata: {
          provider:    'hubspot',
          resource_type: 'contacts',
          id:          record.id,
          email:       p.email ?? null,
          company:     p.company ?? null,
          lifecycle:   p.lifecyclestage ?? null,
        },
      })
    }

    after = data.paging?.next?.after ?? null
    if (!after) break
  }

  return chunks
}