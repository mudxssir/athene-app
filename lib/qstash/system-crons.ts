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
  // Fix: trim trailing slash so destination URLs never get double-slashes.
  // e.g. "https://app.example.com/" + "/api/worker/hitl-cleanup"
  //   → "https://app.example.com/api/worker/hitl-cleanup"  (correct)
  // Without the trim the Set-based dedup would fail to match a schedule
  // stored by QStash without the double slash.
  const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (!APP_URL) {
    logger.warn(
      {},
      '[system-crons] NEXT_PUBLIC_APP_URL not set — skipping cron registration',
    )
    return
  }

  // QStash cloud cannot reach loopback addresses, so cron schedules are
  // meaningless in local dev. Skip silently rather than logging a misleading error.
  if (APP_URL.startsWith('http://localhost') || APP_URL.startsWith('http://127.0.0.1')) {
    logger.info({}, '[system-crons] Localhost detected — skipping cron registration (QStash cannot reach loopback)')
    return
  }

  // ── Step 1: fetch existing schedules ────────────────────────────────────
  let existing: Array<{ destination: string; cron: string; scheduleId: string }>
  try {
    existing = await qstash.schedules.list()
  } catch (listErr: any) {
    // If we can't list schedules, skip registration entirely rather than
    // risk creating duplicates. The next cold start will retry.
    logger.error(
      { err: listErr?.message },
      '[system-crons] Failed to list existing schedules — skipping registration to avoid duplicates',
    )
    return
  }

  // Build a lookup map: destination → registered schedule (for cron-drift detection)
  const existingByDest = new Map(existing.map((s) => [s.destination, s]))

  // ── Step 2: register only new/missing crons ──────────────────────────────
  for (const def of SYSTEM_CRON_DEFS) {
    const destination = `${APP_URL}${def.path}`
    const registeredSchedule = existingByDest.get(destination)

    if (registeredSchedule) {
      // Warn when the cron expression has drifted from the definition —
      // the operator must delete the old schedule and redeploy to update it.
      if (registeredSchedule.cron !== def.cron) {
        logger.warn(
          {
            name: def.name,
            scheduleId: registeredSchedule.scheduleId,
            registeredCron: registeredSchedule.cron,
            expectedCron: def.cron,
          },
          '[system-crons] Cron expression mismatch — delete the old schedule via the admin endpoint and redeploy to update it',
        )
      } else {
        logger.info({ name: def.name, destination }, '[system-crons] Already registered — skipping')
      }
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
