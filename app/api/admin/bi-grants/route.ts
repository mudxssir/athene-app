import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getContextFromHeaders } from '@/lib/supabase/rls-client'
import { assertAdminRole } from '@/lib/auth/rbac'
import { logger } from '@/lib/logger'
import { rateLimit } from '@/lib/redis/client'

export async function GET(req: Request) {
  const context = getContextFromHeaders(req.headers)
  if (!context) return new Response('Unauthorized', { status: 401 })

  // Role guard for GET (ATH-47 #5)
  const isAdmin = await assertAdminRole(context.user_id, context.org_id)
  if (!isAdmin) return new Response('Forbidden', { status: 403 })

  const { searchParams } = new URL(req.url)
  const page = parseInt(searchParams.get('page') || '0')
  const limit = parseInt(searchParams.get('limit') || '100')

  const { data, error } = await supabaseAdmin
    .from('bi_accessible_grants')
    .select('*')
    .eq('org_id', context.org_id)
    .range(page * limit, (page + 1) * limit - 1) // Pagination support (ATH-47 #11)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const context = getContextFromHeaders(req.headers)
  if (!context) return new Response('Unauthorized', { status: 401 })

  // Centralized scoped role check (ATH-47 #1, #10)
  const isAdmin = await assertAdminRole(context.user_id, context.org_id)
  if (!isAdmin) {
     return new Response('Forbidden: Only admin can grant BI access', { status: 403 })
  }

  // Rate limit: 50 grant mutations per org per hour
  const { allowed } = await rateLimit(`bi-grants:post:${context.org_id}`, 50, 3600)
  if (!allowed) return NextResponse.json({ error: 'Rate limit exceeded — try again later' }, { status: 429 })

  const body = await req.json()
  const { resource_id, resource_type } = body

  // Input validation (ATH-47 #2)
  if (!resource_id || !resource_type) {
    return NextResponse.json({ error: 'Missing resource_id or resource_type' }, { status: 400 })
  }

  // Insert grant
  const { data, error } = await supabaseAdmin.from('bi_accessible_grants').insert({
    org_id: context.org_id,
    resource_type,
    resource_id,
    granted_by: context.user_id
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Update visibility with partial success handling (ATH-47 #6)
  if (resource_type === 'document' || resource_type === 'folder') {
    const { error: updateError } = await supabaseAdmin
      .from('document_embeddings')
      .update({ visibility: 'bi_accessible' })
      .eq('document_id', resource_id)
      .eq('org_id', context.org_id)
      
    if (updateError) {
      logger.error({ err: updateError?.message ?? String(updateError) }, "Failed to update visibility")
      return NextResponse.json({ 
        ...data, 
        warning: "Grant created but document visibility sync failed. Manual sync required." 
      }, { status: 201 })
    }
  }

  return NextResponse.json(data)
}
