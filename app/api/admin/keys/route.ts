import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { requireAdmin } from '@/lib/auth/admin'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { deriveOrgKey, getMasterKey } from '@/lib/auth/kms'
import { rateLimit } from '@/lib/redis/client'

/**
 * GET: List all LLM keys for the current organization.
 * Only returns key hints (last 4 chars) and status.
 */
export async function GET() {
  try {
    return await requireAdmin(async (_supabase, { orgId, userId }) => {
      const context = await resolveInternalAdminContext(orgId, userId)

      const { data, error } = await supabaseAdmin
        .from('llm_keys')
        .select('id, provider, key_hint, label, is_active, last_used_at, updated_at')
        .eq('org_id', context.orgId)
        .order('provider', { ascending: true })

      if (error) throw error
      
      // Defense in Depth: Explicitly map to return only safe fields
      const safeData = (data || []).map(k => ({
        id: k.id,
        provider: k.provider,
        key_hint: k.key_hint,
        label: k.label,
        is_active: k.is_active,
        last_used_at: k.last_used_at,
        updated_at: k.updated_at
      }))

      return NextResponse.json(safeData)
    })
  } catch (err: any) {
    return handleApiError(err)
  }
}

/**
 * POST: Add a new LLM key.
 * If an active key already exists for the provider, it will be deactivated (rotated).
 */
export async function POST(req: NextRequest) {
  try {
    // Rate limit before expensive auth — 10 key mutations per org per hour
    const { orgId: clerkOrgId } = await auth()
    if (clerkOrgId) {
      const { allowed } = await rateLimit(`admin:keys:post:${clerkOrgId}`, 10, 3600)
      if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded — try again later' }, { status: 429 })
    }

    const { provider, key, label } = await req.json()

    if (!provider || !key) {
      return NextResponse.json({ error: 'provider and key are required' }, { status: 400 })
    }

    return await requireAdmin(async (_supabase, { orgId, userId }) => {
      const context = await resolveInternalAdminContext(orgId, userId)
      // Derive a per-org encryption key — leaked master key alone can't
      // decrypt any org's data without the org's internal UUID.
      const orgKey = deriveOrgKey(getMasterKey(), context.orgId)

      // Use supabaseAdmin to bypass RLS — session context has Clerk org ID but
      // store_llm_key needs internal UUID; admin is already verified above.
      const { error: storeError } = await supabaseAdmin.rpc('store_llm_key', {
        p_org_id: context.orgId,
        p_provider: provider,
        p_plaintext: key,
        p_kms_key: orgKey,
      })

      if (storeError) throw storeError

      const { data, error: fetchError } = await supabaseAdmin
        .from('llm_keys')
        .select('id, provider, key_hint, label, is_active, last_used_at, updated_at')
        .eq('org_id', context.orgId)
        .eq('provider', provider)
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (fetchError) throw fetchError
      if (!data) return NextResponse.json({ error: 'Key stored but could not be fetched' }, { status: 500 })

      await supabaseAdmin.from('admin_actions').insert({
        org_id: context.orgId,
        admin_user_id: context.adminMemberId,
        action: 'add_key',
        details: { provider, key_id: data.id, label }
      })

      return NextResponse.json(data)
    })
  } catch (err: any) {
    return handleApiError(err)
  }
}

/**
 * PATCH: Update an existing key (toggle status or change label).
 */
export async function PATCH(req: NextRequest) {
  try {
    const { id, is_active, label } = await req.json()

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    return await requireAdmin(async (_supabase, { orgId, userId }) => {
      const context = await resolveInternalAdminContext(orgId, userId)

      const { data: oldKey, error: fetchError } = await supabaseAdmin
        .from('llm_keys')
        .select('provider, label, is_active')
        .eq('id', id)
        .eq('org_id', context.orgId)
        .limit(1)
        .maybeSingle()

      if (fetchError) throw fetchError
      if (!oldKey) return NextResponse.json({ error: 'Key not found' }, { status: 404 })

      const { data, error: updateError } = await supabaseAdmin
        .from('llm_keys')
        // Explicitly select only safe fields — never return encrypted_key to the client
        .update({ is_active, label })
        .eq('id', id)
        .eq('org_id', context.orgId)
        .select('id, provider, key_hint, label, is_active, last_used_at, updated_at')
        .limit(1)
        .maybeSingle()

      if (updateError) throw updateError

      await supabaseAdmin.from('admin_actions').insert({
        org_id: context.orgId,
        admin_user_id: context.adminMemberId,
        action: 'update_key',
        details: {
          key_id: id,
          provider: oldKey.provider,
          changes: { is_active, label }
        }
      })

      return NextResponse.json(data)
    })
  } catch (err: any) {
    return handleApiError(err)
  }
}

/**
 * DELETE: Permanently remove a key.
 */
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    return await requireAdmin(async (_supabase, { orgId, userId }) => {
      const context = await resolveInternalAdminContext(orgId, userId)

      const { data: key, error: fetchError } = await supabaseAdmin
        .from('llm_keys')
        .select('provider')
        .eq('id', id)
        .eq('org_id', context.orgId)
        .limit(1)
        .maybeSingle()

      if (fetchError) throw fetchError
      if (!key) return NextResponse.json({ error: 'Key not found' }, { status: 404 })

      const { error: deleteError } = await supabaseAdmin
        .from('llm_keys')
        .delete()
        .eq('id', id)
        .eq('org_id', context.orgId)

      if (deleteError) throw deleteError

      await supabaseAdmin.from('admin_actions').insert({
        org_id: context.orgId,
        admin_user_id: context.adminMemberId,
        action: 'delete_key',
        details: { key_id: id, provider: key.provider }
      })

      return NextResponse.json({ success: true })
    })
  } catch (err: any) {
    return handleApiError(err)
  }
}

async function resolveInternalAdminContext(clerkOrgId: string, clerkUserId: string) {
  const { data: orgData, error: orgError } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('clerk_org_id', clerkOrgId)
    .limit(1)
    .maybeSingle()

  if (orgError) throw orgError
  if (!orgData) throw new Error('Organization context not found')

  const { data: adminMember, error: memberError } = await supabaseAdmin
    .from('org_members')
    .select('id')
    .eq('clerk_user_id', clerkUserId)
    .eq('org_id', orgData.id)
    .limit(1)
    .maybeSingle()

  if (memberError) throw memberError
  if (!adminMember) throw new Error('Admin member context not found')

  return {
    orgId: orgData.id,
    adminMemberId: adminMember.id,
  }
}

function handleApiError(err: any) {
  logger.error({ err: err.message }, '[API Keys Error]')
  if (err.message === 'Unauthorized') return new NextResponse('Unauthorized', { status: 401 })
  if (err.message === 'Forbidden') return new NextResponse('Forbidden', { status: 403 })
  if (err.message.includes('KMS_KEY')) return NextResponse.json({ error: err.message }, { status: 500 })
  return NextResponse.json({ error: err.message }, { status: 500 })
}
