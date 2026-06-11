// ============================================================
// Salesforce Cases fetcher (ATH-67)
//
// SOQL: expanded to include priority, type, account, dates
// Returns FetchedChunk[] with cursor-based pagination.
// ============================================================

import { salesforceFetch, applySinceTo } from './client'
import type { FetchedChunk } from '@/lib/integrations/base'

const SOQL_BASE = [
  'SELECT',
  'Id,Subject,Description,Status,Priority,Type,',
  'Account.Name,CreatedDate,LastModifiedDate',
  'FROM Case',
].join('')

interface SFCase {
  Id: string
  Subject: string
  Description: string | null
  Status: string
  Priority: string | null
  Type: string | null
  Account: { Name: string } | null
  CreatedDate: string | null
  LastModifiedDate: string | null
}

export async function fetchSalesforceCases(
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
      records: SFCase[]
      nextRecordsUrl?: string
      done: boolean
    }

    for (const r of data.records) {
      chunks.push({
        chunk_id:   `sf-case-${r.Id}`,
        title:      r.Subject,
        content: [
          `Case: ${r.Subject}`,
          `Status: ${r.Status}`,
          r.Priority      ? `Priority: ${r.Priority}`              : null,
          r.Type          ? `Type: ${r.Type}`                      : null,
          r.Account?.Name ? `Account: ${r.Account.Name}`          : null,
          r.Description   ? `Description: ${r.Description}`       : null,
        ].filter(Boolean).join('\n'),
        source_url: `${instanceUrl}/lightning/r/Case/${r.Id}/view`,
        shape: 'work_item' as const,
        metadata: {
          provider:      'salesforce',
          resource_type: 'cases',
          id:            r.Id,
          status:        r.Status,
          priority:      r.Priority ?? null,
          last_modified: r.LastModifiedDate ?? undefined,
        },
      })
    }

    nextUrl = data.done ? null : (data.nextRecordsUrl ?? null)
  }

  return chunks
}