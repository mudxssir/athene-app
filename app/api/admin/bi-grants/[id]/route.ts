import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { getContextFromHeaders } from '@/lib/supabase/rls-client'
import { logger } from '@/lib/logger'

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = getContextFromHeaders(req.headers)
  if (!context) return new Response('Unauthorized', { status: 401 })

  const { data: member } = await supabaseAdmin
    .from('org_members')
    .select('role')
    .eq('id', context.user_id)
    .single()

  if (member?.role !== 'admin' && member?.role !== 'super_user') {
     return new Response('Forbidden: Only admin can delete BI access', { status: 403 })
  }

  // Await the params to get the id
  const { id } = await params

  // Get the grant to know the resource
  const { data: grant } = await supabaseAdmin
    .from('bi_accessible_grants')
    .select('*')
    .eq('grant_id', id)
    .eq('org_id', context.org_id)
    .single()

  if (!grant) return new Response('Not found', { status: 404 })

  const { error } = await supabaseAdmin
    .from('bi_accessible_grants')
    .delete()
    .eq('grant_id', id)
    .eq('org_id', context.org_id)

  if (error) {
    logger.error({ grantId: id, orgId: context.org_id, err: error.message }, '[bi-grants] Delete failed')
    return NextResponse.json({ error: 'Failed to delete BI grant' }, { status: 500 })
  }

  // Revert visibility back to department (defaulting)
  if (grant.resource_type === 'document' || grant.resource_type === 'folder') {
    await supabaseAdmin
      .from('document_embeddings')
      .update({ visibility: 'department' })
      .eq('document_id', grant.resource_id)
      .eq('org_id', context.org_id)
      .eq('visibility', 'bi_accessible') // only if it was bi_accessible
  }

  return NextResponse.json({ success: true })
}
