import { hubspotFetch } from './client'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import type { FetchedChunk } from '@/lib/integrations/base'

async function getOrgConnection(orgId: string, provider: string) {
  const { data, error } = await supabaseAdmin
    .from('nango_connections')
    .select('connection_id')
    .eq('org_id', orgId)
    .eq('provider_config_key', provider)
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return { connectionId: data.connection_id as string }
}

export async function hubspotSearch(
  connectionId: string,
  orgId: string,
  query: string,
  args?: any
): Promise<FetchedChunk[]> {
  const limit = args?.limit ?? 5;
  const conn = await getOrgConnection(orgId, 'hubspot')
  if (!conn) {
    logger.warn({ err: `no active connection for org ${orgId}` }, '[live-search:hubspot] no active connection for org')
    return []
  }

  const objectTypes = ['contacts', 'companies', 'deals'] as const
  const perType     = Math.max(1, Math.ceil(limit / objectTypes.length))
  const results: FetchedChunk[] = []

  for (const objType of objectTypes) {
    try {
      const data = await hubspotFetch(conn.connectionId, `/crm/v3/objects/${objType}/search`, orgId, {
        method: 'POST',
        body: {
          query,
          limit: perType,
        },
      }) as {
        results: Array<{
          id: string
          properties: Record<string, string | null>
        }>
      }

      const singularType = objType.replace(/s$/, '')

      for (const rec of (data.results ?? []).slice(0, perType)) {
        const p = rec.properties || {}
        const title =
          ([p['firstname'], p['lastname']].filter(Boolean).join(' ') ||
          p['name']) ??
          p['dealname'] ??
          rec.id

        const resourceType = objType; // e.g. 'contacts', 'companies', 'deals'
        results.push({
          chunk_id: `hs-${singularType}-${rec.id}`,
          title,
          content: p['description'] ?? p['hs_note_body']?.slice(0, 200) ?? title,
          source_url: `https://app.hubspot.com/contacts/${singularType}/${rec.id}`,
          metadata: {
            provider: 'hubspot',
            resource_type: resourceType,
            id: rec.id
          }
        })
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, `[live-search:hubspot] ${objType} search failed:`)
    }
  }

  return results.slice(0, limit)
}
