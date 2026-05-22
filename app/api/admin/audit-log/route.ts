import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/server'
import { auth } from '@clerk/nextjs/server'
import { resolveUserAccess } from '@/lib/auth/rbac'
import { logger } from '@/lib/logger'

export async function GET(req: Request) {
  const { userId, orgId, orgRole } = await auth()

  if (!userId || !orgId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const access = await resolveUserAccess(userId, orgId, orgRole)
  if (access.role !== 'admin') {
    return new Response('Forbidden', { status: 403 })
  }

  const internalOrgId = access.internal_org_id
  if (!internalOrgId) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  const { searchParams } = new URL(req.url)
  const format = searchParams.get('format') // 'csv' | null
  const page = parseInt(searchParams.get('page') || '0')
  const limit = parseInt(searchParams.get('limit') || '50')
  const search = searchParams.get('search') || ''

  // CSV export fetches all rows (up to 10 000) — no pagination
  const isCSV = format === 'csv'

  let query = supabaseAdmin
    .from('admin_actions')
    .select(`
      *,
      admin:admin_user_id (id, display_name, email),
      target:target_user_id (id, display_name, email)
    `)
    .eq('org_id', internalOrgId)
    .order('performed_at', { ascending: false })

  if (search) {
    // Escape ilike wildcard chars to prevent accidental pattern injection
    const sanitizedSearch = search.replace(/[%_\\]/g, '\\$&')
    query = query.ilike('action', `%${sanitizedSearch}%`)
  }

  if (isCSV) {
    query = query.range(0, 9999)
  } else {
    query = query.range(page * limit, (page + 1) * limit - 1)
  }

  const { data, error, count } = await query

  if (error) {
    logger.error({ orgId: internalOrgId, err: error.message }, '[audit-log] Query failed')
    return NextResponse.json({ error: 'Failed to fetch audit log' }, { status: 500 })
  }

  // ── CSV export ────────────────────────────────────────────────────────────
  if (isCSV) {
    const rows = data ?? []
    const header = ['performed_at', 'action', 'admin_email', 'admin_name', 'target_email', 'target_name', 'details']
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return ''
      const str = typeof v === 'object' ? JSON.stringify(v) : String(v)
      // Wrap in quotes and escape internal quotes
      return `"${str.replace(/"/g, '""')}"`
    }
    const lines = [
      header.join(','),
      ...rows.map((row: any) =>
        [
          escape(row.performed_at),
          escape(row.action),
          escape(row.admin?.email ?? ''),
          escape(row.admin?.display_name ?? ''),
          escape(row.target?.email ?? ''),
          escape(row.target?.display_name ?? ''),
          escape(row.details),
        ].join(',')
      ),
    ]
    const csv = lines.join('\n')
    const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }

  // ── JSON response ─────────────────────────────────────────────────────────
  return NextResponse.json({ logs: data, total: count ?? data?.length ?? 0 })
}
