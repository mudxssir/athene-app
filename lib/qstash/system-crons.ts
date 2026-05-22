// ============================================================
// lib/qstash/system-crons.ts — System-level QStash cron definitions
//
// Single source of truth for the crons that must run on every deploy.
// Imported by:
//   - instrumentation.ts (auto-registers on server startup)
//   - app/api/admin/crons/route.ts (manual admin re-register endpoint)
//
// Registration is idempotent — registerSystemCrons() calls schedules.list()
// first and skips any cron whose destination URL is already registered.
// This prevents N schedules accumulating from N cold-start calls.
// ============================================================

import { qstash } from './client'
import { logger } from '@/lib/logger'

export interface SystemCronDef {
  name: string
  path: string       // path appended to NEXT_PUBLIC_APP_URL
  cron: string       // standard cron expression
}

export const SYSTEM_CRON_DEFS: SystemCronDef[] = [
  {
    name: 'hitl-cleanup',
    path: '/api/worker/hitl-cleanup',
    cron: '*/30 * * * *', // every 30 minutes
  },
  {
    name: 'checkpoint-prune',
    path: '/api/worker/checkpoint-prune',
    cron: '0 2 * * *', // daily at 2 AM UTC
  },
]

/**
 * Idempotently registers all system crons with QStash.
 *
 * Strategy (5C.3 fix):
 *   1. Fetch the current schedule list from QStash.
 *   2. Build a Set of already-registered destination URLs.
 *   3. Only call `schedules.create()` for destinations NOT in that set.
 *
 * This prevents the previous behaviour of calling `schedules.create()` on
 * every cold start, which accumulated O(deploys) duplicate schedules in
 * QStash (each with a distinct scheduleId) and caused repeated job runs.
 *
 * Cron-expression updates: if you change a cron expression for an existing
 * schedule, delete the old schedule via the admin endpoint first, then
 * redeploy so this function recreates it.
 *
 * No-ops silently if NEXT_PUBLIC_APP_URL is not set (local dev without a
 * tunnelled URL). Each cron failure is logged but does NOT throw so that a
 * single failed registration doesn't block server startup.
 */
export async function registerSystemCrons(): Promise<void> {
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL
  if (!APP_URL) {
    logger.warn(
      {},
      '[system-crons] NEXT_PUBLIC_APP_URL not set — skipping cron registration',
    )
    return
  }

  // ── Step 1: fetch existing schedules ────────────────────────────────────
  let existingDestinations: Set<string>
  try {
    const existing = await qstash.schedules.list()
    existingDestinations = new Set(existing.map((s) => s.destination))
  } catch (listErr: any) {
    // If we can't list schedules, skip registration entirely rather than
    // risk creating duplicates. The next cold start will retry.
    logger.error(
      { err: listErr?.message },
      '[system-crons] Failed to list existing schedules — skipping registration to avoid duplicates',
    )
    return
  }

  // ── Step 2: register only new/missing crons ──────────────────────────────
  for (const def of SYSTEM_CRON_DEFS) {
    const destination = `${APP_URL}${def.path}`

    if (existingDestinations.has(destination)) {
      logger.info({ name: def.name, destination }, '[system-crons] Already registered — skipping')
      continue
    }

    try {
      const schedule = await qstash.schedules.create({
        destination,
        cron: def.cron,
        body: JSON.stringify({}),
      })
      logger.info(
        { name: def.name, scheduleId: schedule.scheduleId, destination },
        '[system-crons] Registered',
      )
    } catch (err: any) {
      logger.error({ name: def.name, err: err?.message }, '[system-crons] Registration failed')
    }
  }
}
