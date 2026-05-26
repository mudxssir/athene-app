// ============================================================
// Salesforce base client (ATH-67)
//
// Uses baseFetch<T>() for retry + rate-limit handling.
// Critical rule: token is fetched from Nango per-request,
// used once, then falls out of scope. Never stored, never logged.
// ============================================================

import { baseFetch, getProviderToken, type BaseFetchOptions } from '@/lib/integrations/base'
import { getConnectionMetadata } from '@/lib/nango/client'
import { logger } from '@/lib/logger'

/**
 * Make an authenticated GET request to the Salesforce REST API.
 *
 * @param connectionId – Nango connection ID for this org's Salesforce link
 * @param path – API path appended to `/services/data/v59.0` (e.g. `/query?q=...`)
 * @param orgId – Clerk org ID for ownership verification
 * @param instanceUrl – Salesforce instance URL (e.g. `https://myorg.my.salesforce.com`).
 *   If omitted, fetches it dynamically from Nango connection metadata.
 * @param fetchOptions – Optional retry/method configuration passed to baseFetch
 */
export async function salesforceFetch<T = unknown>(
  connectionId: string,
  path: string,
  orgId: string,
  instanceUrl?: string,
  fetchOptions?: BaseFetchOptions
): Promise<T> {
  let baseUrl = instanceUrl
  
  if (!baseUrl) {
    try {
      const conn = await getConnectionMetadata(connectionId, 'salesforce', orgId)
      baseUrl = conn.metadata?.instance_url || conn.credentials?.instance_url || conn.connection_config?.instance_url || 'https://login.salesforce.com'
    } catch (err) {
      logger.warn({ err }, '[salesforceFetch] Failed to fetch instance_url from Nango metadata, falling back to login.salesforce.com')
      baseUrl = 'https://login.salesforce.com'
    }
  }

  const url = `${baseUrl}/services/data/v59.0${path}`
  const token = await getProviderToken(connectionId, 'salesforce', orgId)

  const headers = {
    ...fetchOptions?.headers,
    Authorization: `Bearer ${token}`
  }

  return baseFetch<T>(url, { ...fetchOptions, headers })
}

// SOQL datetime literals must be ISO 8601 — validate before interpolating
// to prevent malformed queries or SOQL injection via crafted `since` values.
const SOQL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/

/**
 * Appends a `WHERE LastModifiedDate >= {since}` clause to a SOQL base string.
 * Throws if `since` is not a valid ISO 8601 datetime to prevent SOQL injection.
 */
export function applySinceTo(soqlBase: string, since: string | undefined): string {
  if (!since) return soqlBase
  if (!SOQL_DATETIME_RE.test(since)) {
    throw new Error(`[salesforce] Invalid since value — expected ISO 8601 datetime, got: ${since}`)
  }
  return `${soqlBase} WHERE LastModifiedDate >= ${since}`
}
