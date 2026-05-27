/**
 * Google API client — built on top of the shared baseFetch.
 * All Google fetchers (Drive, Gmail, Calendar) use this
 * instead of calling fetch() directly.
 */
import { baseFetch, baseFetchRaw, getProviderToken } from '@/lib/integrations/base'

/**
 * Authenticated fetch wrapper for Google APIs.
 * Retrieves the Nango token for the Google service and
 * delegates to baseFetch for automatic retry + rate-limit handling.
 *
 * @param connectionId - Nango connection ID.
 * @param orgId        - Organization ID for ownership verification.
 * @param url          - The full Google API URL to call.
 * @param options      - Optional method, headers, body overrides.
 * @returns Parsed response of type T.
 */
export async function googleFetch<T = any>(
  connectionId: string,
  orgId: string,
  url: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    headers?: Record<string, string>
    body?: unknown
  } = {},
): Promise<T> {
  const token = await getProviderToken(connectionId, 'google', orgId)

  return baseFetch<T>(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  })
}

/**
 * Raw response variant of googleFetch for binary downloads.
 * Used for Drive file content (PDFs, images, etc.).
 */
export async function googleFetchRaw(
  connectionId: string,
  orgId: string,
  url: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    headers?: Record<string, string>
    body?: unknown
  } = {},
): Promise<Response> {
  const token = await getProviderToken(connectionId, 'google', orgId)

  return baseFetchRaw(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
    timeoutMs: 120_000, // binary downloads can be large
  })
}
