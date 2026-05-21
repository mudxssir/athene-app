import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { mapRole } from '@/lib/auth/clerk'
import { listConnections, deleteConnection, saveConnectionMapping } from '@/lib/nango/client'
import { PROVIDER_REGISTRY } from '@/lib/integrations/providers'
import { supabaseAdmin } from '@/lib/supabase/server'
import { invalidatePromptCache } from '@/lib/knowledge-graph/modules/resolver'

/**
 * 🛡️ ADMIN ROLE ENFORCEMENT
 * Shared helper to verify the caller has the "admin" role in the organization.
 */
async function ensureAdmin() {
  const { userId, orgId, orgRole } = await auth()
  if (!userId || !orgId) {
    throw new Error('Unauthorized')
  }

  const role = mapRole(orgRole ?? undefined)
  if (role !== 'admin') {
    throw new Error('Forbidden')
  }

  return { userId, orgId }
}

export async function GET(_req: NextRequest) {
  try {
    const { orgId } = await ensureAdmin()

    // Resolve Clerk orgId → internal UUID first — nango_connections.org_id stores
    // the internal UUID, so listConnections must be called with it (not the Clerk ID).
    const { data: orgData } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('clerk_org_id', orgId)
      .maybeSingle()
    const internalOrgId = orgData?.id as string | undefined

    if (!internalOrgId) {
      // Org not yet synced to Supabase — return empty list rather than crashing
      return NextResponse.json({ integrations: [] })
    }

    const connections = await listConnections(internalOrgId)

    // Batch-count documents and load metadata per nango connection.
    // connections.org_id stores internal UUIDs — use internalOrgId for correct filtering.
    const { data: connRows } = internalOrgId
      ? await supabaseAdmin
          .from('connections')
          .select('id, nango_connection_id, metadata, status, documents(count)')
          .eq('org_id', internalOrgId)
      : { data: null }

    const metaByNangoId: Record<string, { id: string; metadata: Record<string, unknown>; status: string | null; docCount: number }> = {}
    for (const row of connRows ?? []) {
      const count = Array.isArray(row.documents) ? (row.documents[0] as any)?.count ?? 0 : 0
      metaByNangoId[row.nango_connection_id] = {
        id: row.id,
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        status: (row as any).status ?? null,
        docCount: Number(count),
      }
    }

    const integrations = (connections as any[]).map((conn) => {
      const providerKey = (conn.provider_config_key ?? conn.provider) as string
      const nangoConnId = conn.connection_id ?? conn.id
      const config = PROVIDER_REGISTRY[providerKey as keyof typeof PROVIDER_REGISTRY]
      const meta = metaByNangoId[nangoConnId]
      return {
        connectionId: nangoConnId,
        internalConnectionId: meta?.id ?? '',
        provider: providerKey,
        displayName: config?.displayName ?? providerKey,
        category: config?.category ?? 'other',
        resources: config?.resources ?? [],
        status: (() => {
          const raw = meta?.status || conn.sync_status || (conn.errors?.length ? 'error' : 'connected')
          if (raw === 'active' || raw === 'connected') {
            if (conn.last_synced_at) {
              const lastSynced = new Date(conn.last_synced_at)
              const diffHours = (Date.now() - lastSynced.getTime()) / (1000 * 60 * 60)
              if (diffHours > 24) {
                return 'stale'
              }
            }
            return 'connected'
          }
          if (raw === 'syncing') return 'syncing'
          if (raw === 'error' || raw === 'failed') return 'error'
          return 'connected'
        })(),
        lastSyncedAt: conn.last_synced_at ?? null,
        totalDocs: meta?.docCount ?? 0,
        metadata: meta?.metadata ?? {},
        createdAt: conn.created_at ?? null,
      }
    })

    return NextResponse.json({ integrations })
  } catch (err: any) {
    if (err.message === 'Unauthorized') return new NextResponse('Unauthorized', { status: 401 })
    if (err.message === 'Forbidden') return new NextResponse('Forbidden', { status: 403 })
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { orgId } = await ensureAdmin()
    
    let body: { connectionId?: string; provider?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { connectionId, provider } = body
    if (!connectionId || !provider) {
      return NextResponse.json({ error: 'connectionId and provider are required' }, { status: 400 })
    }

    // Resolve Clerk orgId → internal UUID (required for connections table FK)
    const { data: orgData } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('clerk_org_id', orgId)
      .maybeSingle()

    const internalOrgId = orgData?.id as string | undefined

    // Save Nango connection mapping (use internal UUID when available)
    await saveConnectionMapping(internalOrgId ?? orgId, connectionId, provider)

    // Upsert into connections table so browse/configure routes can find this connection
    let internalConnectionId: string | undefined
    if (internalOrgId) {
      // Find existing row first (avoid duplicate on reconnect)
      const { data: existing } = await supabaseAdmin
        .from('connections')
        .select('id')
        .eq('org_id', internalOrgId)
        .eq('nango_connection_id', connectionId)
        .maybeSingle()

      if (existing) {
        internalConnectionId = existing.id
      } else {
        const { data: newConn } = await supabaseAdmin
          .from('connections')
          .insert({
            org_id: internalOrgId,
            nango_connection_id: connectionId,
            provider: provider.toLowerCase(),
            source_type: provider.toLowerCase(),
            scope: 'org',
            status: 'active',
            metadata: {},
          })
          .select('id')
          .maybeSingle()
        internalConnectionId = newConn?.id
      }
    }

    return NextResponse.json({ success: true, internalConnectionId })
  } catch (err: any) {
    if (err.message === 'Unauthorized') return new NextResponse('Unauthorized', { status: 401 })
    if (err.message === 'Forbidden') return new NextResponse('Forbidden', { status: 403 })
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { orgId } = await ensureAdmin()

    let body: { connectionId?: string; provider?: string }
    try {
      body = await req.json()
    } catch {
      // Fallback to query params if JSON body is missing
      const { searchParams } = new URL(req.url)
      body = {
        connectionId: searchParams.get('connectionId') ?? undefined,
        provider: searchParams.get('provider') ?? searchParams.get('providerConfigKey') ?? undefined
      }
    }

    const { connectionId, provider } = body
    if (!connectionId || !provider) {
      return NextResponse.json({ error: 'connectionId and provider are required' }, { status: 400 })
    }

    await deleteConnection(connectionId, provider, orgId)

    // Resolve internal org UUID and invalidate KG prompt cache so the removed
    // integration's module addendum no longer contributes to extraction
    const { data: orgData } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('clerk_org_id', orgId)
      .maybeSingle()
    if (orgData?.id) void invalidatePromptCache(orgData.id)

    return NextResponse.json({ success: true })
  } catch (err: any) {
    if (err.message === 'Unauthorized') return new NextResponse('Unauthorized', { status: 401 })
    if (err.message === 'Forbidden') return new NextResponse('Forbidden', { status: 403 })
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
