export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ============================================================
// app/api/worker/scope-summary/route.ts — P6-6
//
// Debounced summary worker: regenerates summaries for an org's dirty scopes
// bottom-up (community → app → vertical/dept → org, children before parents),
// skipping any whose input_hash is unchanged. Processes a capped batch per
// invocation and re-enqueues (deduped) while more remain. Dormant when
// HIERARCHY_SCOPES is off.
//
// Payload: { org_id: string }
// ============================================================

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify'
// SERVICE-ROLE JUSTIFICATION: QStash-verified background worker; writes sync_errors (DLQ) — no user-facing reads.
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { parseBody, uuidSchema } from '@/lib/validation'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import { selectDirtyScopes, summarizeScope, enqueueScopeSummary } from '@/lib/knowledge-graph/scope-summary'

const Schema = z.object({ org_id: uuidSchema })

/** Summaries per invocation (each is one LLM call). Re-enqueue handles the rest. */
const SUMMARY_BATCH = 25

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
  const { org_id } = parsed.data

  try {
    const dirty = await selectDirtyScopes(org_id, SUMMARY_BATCH)
    const counts = { generated: 0, unchanged: 0, empty: 0, error: 0 }
    for (const scope of dirty) {
      counts[await summarizeScope(org_id, scope)]++
    }
    // If we filled the batch there are likely more dirty scopes — continue.
    if (dirty.length === SUMMARY_BATCH) enqueueScopeSummary(org_id)

    logger.info({ org_id, ...counts, more: dirty.length === SUMMARY_BATCH }, '[scope-summary] batch complete')
    return NextResponse.json({ status: 'ok', ...counts })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ org_id, err: message }, '[scope-summary] Fatal error')
    try {
      await supabaseAdmin.from('sync_errors').upsert({
        org_id, job_type: 'scope-summary', document_id: null,
        error: message.slice(0, 500), occurred_at: new Date().toISOString(),
      }, { onConflict: 'org_id,job_type,document_id' })
    } catch { /* DLQ write failure is non-fatal */ }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
