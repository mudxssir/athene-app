import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { z } from 'zod'
import { mapRole } from '@/lib/auth/clerk'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getConnection } from '@/lib/nango/client'
import { parseBody } from '@/lib/validation'

const CheckSchema = z.object({ provider: z.string().min(1).max(100) })

async function ensureAdmin() {
  const { userId, orgId, orgRole } = await auth()
  if (!userId || !orgId) throw new Error('Unauthorized')
  if (mapRole(orgRole ?? undefined) !== 'admin') throw new Error('Forbidden')
  return { userId, clerkOrgId: orgId }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { clerkOrgId } = await ensureAdmin()
    const { id: nangoConnectionId } = await params

    let raw: unknown
    try { raw = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
    const parsed = parseBody(CheckSchema, raw)
    if (!parsed.success) return parsed.response
    const { provider } = parsed.data

    // Resolve internal org UUID
    const { data: orgData } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('clerk_org_id', clerkOrgId)
      .maybeSingle()

    if (!orgData) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
    }
    const internalOrgId = orgData.id as string

    try {
      // 1. Try to fetch connection from Nango to check token validity
      const conn = await getConnection(nangoConnectionId, provider, internalOrgId)
      
      // Connection is valid! Update sync_status to connected
      await supabaseAdmin
        .from('nango_connections')
        .update({ sync_status: 'connected' })
        .eq('org_id', internalOrgId)
        .eq('connection_id', nangoConnectionId)

      // Also update status in connections table
      await supabaseAdmin
        .from('connections')
        .update({ status: 'active' })
        .eq('org_id', internalOrgId)
        .eq('nango_connection_id', nangoConnectionId)

      return NextResponse.json({
        success: true,
        status: 'connected',
        lastSyncedAt: (conn as any)?.last_synced_at ?? null,
      })

    } catch (err: any) {
      // If error indicates auth failure or connection invalidity
      const isAuthFailure = err.reconnect_required || err.reason === 'AUTH_FAILURE' || err.status === 401
      
      if (isAuthFailure) {
        // Update database statuses to error/failed
        await supabaseAdmin
          .from('nango_connections')
          .update({ sync_status: 'error' })
          .eq('org_id', internalOrgId)
          .eq('connection_id', nangoConnectionId)

        await supabaseAdmin
          .from('connections')
          .update({ status: 'error' })
          .eq('org_id', internalOrgId)
          .eq('nango_connection_id', nangoConnectionId)
      }

      return NextResponse.json({
        success: false,
        status: 'error',
        error: err.message || String(err),
        reconnectRequired: !!isAuthFailure
      })
    }

  } catch (err: any) {
    if (err.message === 'Unauthorized') return new NextResponse('Unauthorized', { status: 401 })
    if (err.message === 'Forbidden') return new NextResponse('Forbidden', { status: 403 })
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
