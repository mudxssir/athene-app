export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ============================================================
// app/api/worker/scope-backfill/route.ts — P6-4
//
// QStash worker that backfills KG scope memberships one node-page at a time and
// re-enqueues itself for the next page until the org's graph is exhausted
// (Vercel-timeout safe, resumable). Dormant when HIERARCHY_SCOPES is off.
//
// Payload: { org_id: string, cursor?: string }
// ============================================================

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify'
// SERVICE-ROLE JUSTIFICATION: QStash-verified background worker; writes sync_errors (DLQ) — no user-facing reads.
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { parseBody, uuidSchema } from '@/lib/validation'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import { backfillScopeMembershipsPage, enqueueScopeBackfill } from '@/lib/knowledge-graph/scope-backfill'
import { buildCommunityScopes } from '@/lib/knowledge-graph/community-scopes'

const Schema = z.object({
  org_id: uuidSchema,
  cursor: z.string().optional(),
})

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await verifyQStashSignature(request))) {
    return NextResponse.json({ error: 'Invalid QStash signature' }, { status: 401 })
  }
  if (!(await checkIdempotency(request))) {
    return NextResponse.json({ status: 'ok', skipped: 'duplicate' })
  }
  if (!HIERARCHY_SCOPES) {
    return NextResponse.json({ status: 'ok', skipped: 'flag-off' })
  }

  let raw: unknown
  try { raw = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = parseBody(Schema, raw)
  if (!parsed.success) return parsed.response
  const { org_id, cursor } = parsed.data

  try {
    const { processed, nextCursor } = await backfillScopeMembershipsPage(org_id, cursor ?? '')
    if (nextCursor) {
      enqueueScopeBackfill(org_id, nextCursor) // continue paging
    } else {
      // Membership backfill done → (re)build per-app community scopes (P6-5).
      await buildCommunityScopes(org_id)
    }
    logger.info({ org_id, processed, done: !nextCursor }, '[scope-backfill] page complete')
    return NextResponse.json({ status: 'ok', processed, done: !nextCursor })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ org_id, err: message }, '[scope-backfill] Fatal error')
    try {
      await supabaseAdmin.from('sync_errors').upsert({
        org_id, job_type: 'scope-backfill', document_id: null,
        error: message.slice(0, 500), occurred_at: new Date().toISOString(),
      }, { onConflict: 'org_id,job_type,document_id' })
    } catch { /* DLQ write failure is non-fatal */ }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
