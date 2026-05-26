// ============================================================
// Salesforce Accounts fetcher (ATH-67)
//
// SOQL: expanded to include revenue, headcount, location, owner
// Returns FetchedChunk[] with cursor-based pagination.
// ============================================================

import { salesforceFetch, applySinceTo } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

const SOQL_BASE = [
  'SELECT',
  'Id,Name,Industry,Description,',
  'AnnualRevenue,NumberOfEmployees,',
  'BillingCity,BillingCountry,Phone,Website,',
  'Owner.Name,LastModifiedDate',
  'FROM Account',
].join('')

interface SFAccount {
  Id: string
  Name: string
  Industry: string | null
  Description: string | null
  AnnualRevenue: number | null
  NumberOfEmployees: number | null
  BillingCity: string | null
  BillingCountry: string | null
  Phone: string | null
  Website: string | null
  Owner: { Name: string } | null
  LastModifiedDate: string | null
}

export async function fetchSalesforceAccounts(
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
      records: SFAccount[]
      nextRecordsUrl?: string
      done: boolean
    }

    for (const r of data.records) {
      const revenue  = r.AnnualRevenue  ? `$${r.AnnualRevenue.toLocaleString()}`    : null
      const headcount = r.NumberOfEmployees ? `${r.NumberOfEmployees.toLocaleString()} employees` : null
      const location = [r.BillingCity, r.BillingCountry].filter(Boolean).join(', ') || null

      chunks.push({
        chunk_id:   `sf-account-${r.Id}`,
        title:      r.Name,
        content: [
          `Account: ${r.Name}`,
          r.Industry   ? `Industry: ${r.Industry}`         : null,
          revenue      ? `Annual Revenue: ${revenue}`      : null,
          headcount    ? `Employees: ${headcount}`         : null,
          location     ? `Location: ${location}`           : null,
          r.Phone      ? `Phone: ${r.Phone}`               : null,
          r.Website    ? `Website: ${r.Website}`           : null,
          r.Owner?.Name ? `Owner: ${r.Owner.Name}`         : null,
          r.Description ? `Description: ${r.Description}` : null,
        ].filter(Boolean).join('\n'),
        source_url: `${instanceUrl}/lightning/r/Account/${r.Id}/view`,
        metadata: {
          provider:      'salesforce',
          resource_type: 'accounts',
          id:            r.Id,
          industry:      r.Industry ?? null,
          last_modified: r.LastModifiedDate ?? undefined,
        },
      })
    }

    nextUrl = data.done ? null : (data.nextRecordsUrl ?? null)
  }

  return chunks
}