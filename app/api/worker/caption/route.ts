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
import { logger } from '@/lib/logger'
import { parseBody, uuidSchema } from '@/lib/validation'
import { MEDIA_CAPTIONS } from '@/lib/config/feature-flags'
import { runCaptionDrain, type DrainSummary } from '@/lib/integrations/caption-worker'
import { listOrgsWithQueuedMedia } from '@/lib/integrations/media-queue'

const CaptionSchema = z.object({
  // Optional: present for a targeted per-org drain, absent for the cron fan-out.
  org_id: uuidSchema.optional(),
})

/** Cap on orgs drained per cron tick (each drains one batch; rest wait for the next tick). */
const MAX_ORGS_PER_TICK = 50

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

  try {
    // Targeted single-org drain.
    if (org_id) {
      const summary = await runCaptionDrain(org_id)
      logger.info({ org_id, ...summary }, '[caption] Drain complete')
      return NextResponse.json({ status: 'ok', org_id, ...summary })
    }

    // Cron fan-out: drain every org with queued media (bounded).
    const orgs = (await listOrgsWithQueuedMedia()).slice(0, MAX_ORGS_PER_TICK)
    const totals: DrainSummary & { orgs: number } = {
      orgs: orgs.length, claimed: 0, captioned: 0, deduped: 0, skipped: 0, failed: 0, deferred: 0, requeued: 0,
    }
    for (const o of orgs) {
      const s = await runCaptionDrain(o)
      totals.claimed += s.claimed; totals.captioned += s.captioned; totals.deduped += s.deduped
      totals.skipped += s.skipped; totals.failed += s.failed; totals.deferred += s.deferred
      totals.requeued += s.requeued
    }
    logger.info(totals, '[caption] Cron fan-out complete')
    return NextResponse.json({ status: 'ok', ...totals })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ org_id, err: message }, '[caption] Fatal error')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
