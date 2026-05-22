import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { z } from 'zod'
import { mapRole } from '@/lib/auth/clerk'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { parseBody } from '@/lib/validation'

const SaveResourcesSchema = z.object({
  connectionId: z.string().min(1).max(255),
  selections:   z.array(z.unknown()).or(z.record(z.string(), z.unknown())),
})

export async function POST(req: NextRequest) {
  try {
    const { userId, orgId, orgRole } = await auth()
    if (!userId || !orgId) return new NextResponse('Unauthorized', { status: 401 })
    if (mapRole(orgRole ?? undefined) !== 'admin') return new NextResponse('Forbidden', { status: 403 })

    let raw: unknown
    try { raw = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
    const parsed = parseBody(SaveResourcesSchema, raw)
    if (!parsed.success) return parsed.response
    const { connectionId, selections } = parsed.data

    // 1. Find the internal connection UUID from the nango_connection_id
    // Wait, the connections table uses nango_connection_id but its PK is 'id' (UUID)
    const { data: conn, error: connErr } = await supabaseAdmin
      .from('connections')
      .select('id')
      .eq('nango_connection_id', connectionId)
      .eq('org_id', (await supabaseAdmin.from('organizations').select('id').eq('clerk_org_id', orgId).single()).data?.id)
      .single()

    // Actually, let's simplify finding the org UUID
    const { data: orgData } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .eq('clerk_org_id', orgId)
      .single()
    
    if (!orgData) throw new Error("Organization not found")

    const { data: targetConn, error: targetErr } = await supabaseAdmin
      .from('connections')
      .select('id, sync_config')
      .eq('nango_connection_id', connectionId)
      .eq('org_id', orgData.id)
      .single()

    if (targetErr || !targetConn) {
      return NextResponse.json({ error: 'Connection record not found in Supabase' }, { status: 404 })
    }

    // 2. Update the sync_config with the new selections
    const newConfig = {
      ...targetConn.sync_config,
      selected_resources: selections
    }

    const { error: updateErr } = await supabaseAdmin
      .from('connections')
      .update({ sync_config: newConfig })
      .eq('id', targetConn.id)

    if (updateErr) throw updateErr

    return NextResponse.json({ success: true })
  } catch (err: any) {
    logger.error({ err: err?.message }, '[resources-save-api] Error')
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
