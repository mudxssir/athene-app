// ============================================================
// Salesforce Contacts fetcher (Issue 9)
//
// SOQL: Id, Name, Email, Phone, Title, Account.Name, Owner.Name, LastModifiedDate
// Delta sync: append WHERE LastModifiedDate >= {since} when options.since provided
// Returns FetchedChunk[] with nextRecordsUrl cursor pagination.
// ============================================================

import { salesforceFetch, applySinceTo } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

const SOQL_BASE = [
  'SELECT',
  'Id,Name,Email,Phone,Title,',
  'Account.Name,Owner.Name,LastModifiedDate',
  'FROM Contact',
].join('')

interface SFContact {
  Id: string
  Name: string
  Email: string | null
  Phone: string | null
  Title: string | null
  Account: { Name: string } | null
  Owner: { Name: string } | null
  LastModifiedDate: string | null
}

export async function fetchSalesforceContacts(
  connectionId: string,
  instanceUrl: string,
  orgId: string,
  options?: { since?: string }
): Promise<FetchedChunk[]> {
  const soql = applySinceTo(SOQL_BASE, options?.since)
  const chunks: FetchedChunk[] = []
  let nextUrl: string | null = `/query?q=${encodeURIComponent(soql)}`

  while (nextUrl) {
    const data = await salesforceFetch(connectionId, nextUrl, orgId, instanceUrl) as {
      records: SFContact[]
      nextRecordsUrl?: string
      done: boolean
    }

    for (const r of data.records) {
      chunks.push({
        chunk_id:   `sf-contact-${r.Id}`,
        title:      r.Name,
        content: [
          `Contact: ${r.Name}`,
          r.Title          ? `Title: ${r.Title}`                : null,
          r.Email          ? `Email: ${r.Email}`                : null,
          r.Phone          ? `Phone: ${r.Phone}`                : null,
          r.Account?.Name  ? `Account: ${r.Account.Name}`      : null,
          r.Owner?.Name    ? `Owner: ${r.Owner.Name}`          : null,
        ].filter(Boolean).join('\n'),
        source_url: `${instanceUrl}/lightning/r/Contact/${r.Id}/view`,
        metadata: {
          provider:      'salesforce',
          resource_type: 'contact',
          id:            r.Id,
          email:         r.Email ?? null,
          last_modified: r.LastModifiedDate ?? undefined,
        },
      })
    }

    nextUrl = data.done ? null : (data.nextRecordsUrl ?? null)
  }

  return chunks
}
