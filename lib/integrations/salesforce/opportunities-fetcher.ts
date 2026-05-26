// ============================================================
// Salesforce Opportunities fetcher (ATH-67)
//
// SOQL: expanded to include amount, close date, probability, account, owner
// Returns FetchedChunk[] with cursor-based pagination.
// ============================================================

import { salesforceFetch, applySinceTo } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

const SOQL_BASE = [
  'SELECT',
  'Id,Name,StageName,Description,',
  'Amount,CloseDate,Probability,',
  'Account.Name,Owner.Name,LastModifiedDate',
  'FROM Opportunity',
].join('')

interface SFOpportunity {
  Id: string
  Name: string
  StageName: string
  Description: string | null
  Amount: number | null
  CloseDate: string | null
  Probability: number | null
  Account: { Name: string } | null
  Owner: { Name: string } | null
  LastModifiedDate: string | null
}

export async function fetchSalesforceOpportunities(
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
      records: SFOpportunity[]
      nextRecordsUrl?: string
      done: boolean
    }

    for (const r of data.records) {
      const amount      = r.Amount      ? `$${r.Amount.toLocaleString()}`      : null
      const probability = r.Probability != null ? `${r.Probability}%`          : null
      const closeDate   = r.CloseDate   ? new Date(r.CloseDate).toLocaleDateString() : null

      chunks.push({
        chunk_id:   `sf-opportunity-${r.Id}`,
        title:      r.Name,
        content: [
          `Opportunity: ${r.Name}`,
          `Stage: ${r.StageName}`,
          amount        ? `Amount: ${amount}`                 : null,
          probability   ? `Win Probability: ${probability}`  : null,
          closeDate     ? `Close Date: ${closeDate}`         : null,
          r.Account?.Name ? `Account: ${r.Account.Name}`    : null,
          r.Owner?.Name   ? `Owner: ${r.Owner.Name}`        : null,
          r.Description   ? `Description: ${r.Description}` : null,
        ].filter(Boolean).join('\n'),
        source_url: `${instanceUrl}/lightning/r/Opportunity/${r.Id}/view`,
        metadata: {
          provider:      'salesforce',
          resource_type: 'opportunities',
          id:            r.Id,
          stage:         r.StageName,
          amount:        r.Amount != null ? String(r.Amount) : null,
          last_modified: r.LastModifiedDate ?? undefined,
        },
      })
    }

    nextUrl = data.done ? null : (data.nextRecordsUrl ?? null)
  }

  return chunks
}