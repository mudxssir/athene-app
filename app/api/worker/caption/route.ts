export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ============================================================
// app/api/worker/caption/route.ts — P5-5
//
// QStash-triggered caption worker (media shape). Two entry modes:
//   · { org_id }  — drain one org's media queue (enqueued per org, deduped).
//   · {} (cron)   — fan out: drain every org with queued media (system cron).
//
// All heavy logic lives in lib/integrations/caption-worker.ts (unit-tested);
// this route is a thin QStash-auth + dispatch wrapper, mirroring embed-retry.
// Dormant when MEDIA_CAPTIONS is off (the drain returns immediately).
// ============================================================

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify'
// SERVICE-ROLE JUSTIFICATION: QStash-verified background worker; writes sync_errors (DLQ) — no user-facing reads.
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { parseBody, uuidSchema } from '@/lib/validation'
import { MEDIA_CAPTIONS } from '@/lib/config/feature-flags'
import { runCaptionDrain, enqueueCaptionDrain } from '@/lib/integrations/caption-worker'
import { listOrgsWithQueuedMedia } from '@/lib/integrations/media-queue'

const CaptionSchema = z.object({
  // Optional: present for a targeted per-org drain, absent for the cron fan-out.
  org_id: uuidSchema.optional(),
})

/** Cap on orgs fanned out per cron tick (each gets its own enqueued drain job). */
const MAX_ORGS_PER_TICK = 200

export async function POST(request: Request): Promise<NextResponse> {
  const isValid = await verifyQStashSignature(request)
  if (!isValid) {
    return NextResponse.json({ error: 'Invalid QStash signature' }, { status: 401 })
  }

  const isFirstTime = await checkIdempotency(request)
  if (!isFirstTime) {
    logger.info('[caption] Skipping duplicate job (idempotency)')
    return NextResponse.json({ status: 'ok', skipped: 'duplicate' })
  }

  if (!MEDIA_CAPTIONS) {
    return NextResponse.json({ status: 'ok', skipped: 'flag-off' })
  }

  let raw: unknown
  try { raw = await request.json() } catch { raw = {} }
  const parsed = parseBody(CaptionSchema, raw)
  if (!parsed.success) return parsed.response
  const { org_id } = parsed.data

  // Cron fan-out (no org_id): enqueue ONE drain job per org with queued media, so
  // each org drains inside its own worker invocation (its own maxDuration budget).
  // Draining all orgs inline here would risk a 300s timeout once vision calls add up.
  if (!org_id) {
    try {
      const orgs = (await listOrgsWithQueuedMedia()).slice(0, MAX_ORGS_PER_TICK)
      for (const o of orgs) enqueueCaptionDrain(o)
      logger.info({ orgs: orgs.length }, '[caption] Cron fan-out enqueued')
      return NextResponse.json({ status: 'ok', enqueued: orgs.length })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err: message }, '[caption] Fan-out failed')
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // Targeted single-org drain (one batch ≤ CAPTION_BATCH — fits the function budget).
  try {
    const summary = await runCaptionDrain(org_id)
    logger.info({ org_id, ...summary }, '[caption] Drain complete')
    return NextResponse.json({ status: 'ok', org_id, ...summary })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ org_id, err: message }, '[caption] Fatal error')
    // DLQ: surface the failure on the admin sync-health page (playbook queueing standard).
    try {
      await supabaseAdmin.from('sync_errors').upsert({
        org_id,
        job_type: 'caption',
        document_id: null,
        error: message.slice(0, 500),
        occurred_at: new Date().toISOString(),
      }, { onConflict: 'org_id,job_type,document_id' })
    } catch { /* DLQ write failure is non-fatal */ }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
