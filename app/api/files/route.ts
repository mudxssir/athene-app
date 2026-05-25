import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { getContextFromHeaders } from '@/lib/supabase/rls-client'
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { classifyFileLayer } from '@/lib/files/classify-layer'

export const dynamic = 'force-dynamic'

/**
 * GET /api/files
 *
 * Returns all directly-uploaded files for the org, ordered most-recent first.
 * Reads from the documents table where source_type = 'direct_upload'.
 *
 * Response shape: { files: FileRecord[]; total: number }
 *   - total = real DB row count (may exceed files.length when > 200 rows)
 *   - storagePath is intentionally omitted — download uses document ID instead
 */
export async function GET() {
  const context = getContextFromHeaders(await headers())
  if (!context?.org_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error, count } = await supabaseAdmin
    .from('documents')
    .select('id, title, mime_type, metadata, created_at, last_indexed_at', { count: 'exact' })
    .eq('org_id', context.org_id)
    .eq('source_type', 'direct_upload')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    logger.error({ err: error.message }, '[files/get]')
    return NextResponse.json({ error: 'Failed to load files' }, { status: 500 })
  }

  const files = (data ?? []).map((doc) => {
    const meta = (doc.metadata ?? {}) as Record<string, string>
    const ext = doc.title?.split('.').pop()?.toUpperCase() ?? meta.type ?? 'FILE'

    // Human-readable relative date
    const now = Date.now()
    const created = new Date(doc.created_at).getTime()
    const diffMs = now - created
    const diffMins = Math.floor(diffMs / 60000)
    const diffHrs = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHrs / 24)

    let date = 'Just now'
    if (diffMins < 1) date = 'Just now'
    else if (diffMins < 60) date = `${diffMins} min${diffMins > 1 ? 's' : ''} ago`
    else if (diffHrs < 24) date = `${diffHrs} hour${diffHrs > 1 ? 's' : ''} ago`
    else if (diffDays === 1) date = 'Yesterday'
    else date = `${diffDays} days ago`

    const status = doc.last_indexed_at ? 'Indexed' : 'Indexing'
    const layer = meta.layer ?? classifyFileLayer(doc.title ?? '', ext)

    return {
      id: doc.id,
      name: doc.title ?? 'Untitled',
      type: ext,
      size: meta.size ?? '—',
      date,
      status,
      risk: 'Low',
      layer,
      // storagePath intentionally omitted — clients use /api/files/download?id= instead
    }
  })

  return NextResponse.json({ files, total: count ?? files.length })
}

/**
 * DELETE /api/files?id=<document_uuid>
 *
 * Removes the document from Supabase Storage and from the documents table.
 * The storage path is stored in documents.external_id.
 */
export async function DELETE(req: NextRequest) {
  const context = getContextFromHeaders(await headers())
  if (!context?.org_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = req.nextUrl.searchParams.get('id')
  if (!id) {
    return NextResponse.json({ error: 'Missing ?id parameter' }, { status: 400 })
  }

  // Fetch the document to verify ownership and get the storage path
  const { data: doc, error: fetchErr } = await supabaseAdmin
    .from('documents')
    .select('id, org_id, external_id, source_type')
    .eq('id', id)
    .eq('org_id', context.org_id)
    .eq('source_type', 'direct_upload')
    .maybeSingle()

  if (fetchErr) {
    logger.error({ err: fetchErr.message }, '[files/delete] fetch error')
    return NextResponse.json({ error: 'Failed to look up document' }, { status: 500 })
  }
  if (!doc) {
    return NextResponse.json({ error: 'Document not found or access denied' }, { status: 404 })
  }

  // 1. Remove from Supabase Storage (best-effort — don't block on storage errors)
  if (doc.external_id) {
    const { error: storageErr } = await supabaseAdmin.storage
      .from('documents')
      .remove([doc.external_id])

    if (storageErr) {
      logger.warn({ detail: String(storageErr.message) }, '[files/delete] Storage remove failed (continuing)')
    }
  }

  // 2. Delete document row (cascades to document_embeddings via FK)
  const { error: deleteErr } = await supabaseAdmin
    .from('documents')
    .delete()
    .eq('id', id)
    .eq('org_id', context.org_id)

  if (deleteErr) {
    logger.error({ err: deleteErr.message }, '[files/delete] DB delete error')
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 })
  }

  return NextResponse.json({ status: 'deleted', id })
}
