export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ============================================================
// app/api/worker/person-scope/route.ts — P6-7
//
// Three modes:
//   { org_id, member_id }   → materialize one member's person scope.
//   { org_id, mode:'maintain' } → daily sweep stale scopes + canary drift check.
//   {} (cron)               → fan out a maintain job per org with person scopes.
//
// Dormant when HIERARCHY_SCOPES is off.
// ============================================================

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify'
// SERVICE-ROLE JUSTIFICATION: QStash-verified background worker; writes sync_errors (DLQ) — no user-facing reads.
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { parseBody, uuidSchema } from '@/lib/validation'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import {
  materializePersonScope,
  sweepStalePersonScopes,
  canaryCheck,
  listOrgsWithPersonScopes,
  enqueuePersonScopeMaintain,
} from '@/lib/knowledge-graph/person-scope'

const Schema = z.object({
  org_id: uuidSchema.optional(),
  member_id: uuidSchema.optional(),
  mode: z.enum(['materialize', 'maintain']).optional(),
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
  try { raw = await request.json() } catch { raw = {} }
  const parsed = parseBody(Schema, raw)
  if (!parsed.success) return parsed.response
  const { org_id, member_id, mode } = parsed.data

  try {
    // Cron fan-out: enqueue a maintain per org with person scopes.
    if (!org_id) {
      const orgs = await listOrgsWithPersonScopes()
      for (const o of orgs) enqueuePersonScopeMaintain(o)
      return NextResponse.json({ status: 'ok', enqueued: orgs.length })
    }

    // Daily maintain: sweep stale + canary.
    if (mode === 'maintain' || !member_id) {
      const sweep = await sweepStalePersonScopes(org_id)
      const canary = await canaryCheck(org_id)
      logger.info({ org_id, ...sweep, ...canary }, '[person-scope] maintain complete')
      return NextResponse.json({ status: 'ok', ...sweep, ...canary })
    }

    // Materialize one member.
    const result = await materializePersonScope(org_id, member_id)
    return NextResponse.json({ status: 'ok', materialized: !!result, memberCount: result?.memberCount ?? 0 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ org_id, err: message }, '[person-scope] Fatal error')
    if (org_id) {
      try {
        await supabaseAdmin.from('sync_errors').upsert({
          org_id, job_type: 'person-scope', document_id: null,
          error: message.slice(0, 500), occurred_at: new Date().toISOString(),
        }, { onConflict: 'org_id,job_type,document_id' })
      } catch { /* DLQ write failure is non-fatal */ }
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
