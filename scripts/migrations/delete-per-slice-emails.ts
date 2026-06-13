#!/usr/bin/env tsx
/**
 * scripts/migrations/delete-per-slice-emails.ts — P3-7 (audit D4)
 *
 * Deletes the OLD per-slice email `documents` rows so the next sync re-indexes
 * mailboxes under the P3-5 one-chunk-per-email scheme. `document_embeddings`
 * rows cascade-delete with their parent document (FK ON DELETE CASCADE).
 *
 * Usage:
 *   npx tsx scripts/migrations/delete-per-slice-emails.ts --org <org_id> [--execute] [--batch 200]
 *
 * SAFETY — dry run is the DEFAULT. Without `--execute` the script only COUNTS and
 * samples the rows it would delete and writes nothing. Per the playbook this
 * migration is "reversible only by re-index" — drill on a staging org first, then
 * pass `--execute`. After deletion, trigger a normal mailbox sync to re-index.
 *
 * Precise matching (IMPORTANT): the playbook shorthand `external_id LIKE 'gmail:%:%'`
 * is WRONG after P3-8/P3-9 — it would also match the NEW `gmail:{id}:ical:{n}`
 * (calendar) and `gmail:thread:{id}` (thread parent) documents. Only the old
 * per-slice rows end in `:{integer}` with a single id segment, so we match
 * `^gmail:[^:]+:\d+$` / `^ms_email_[^:]+:\d+$` exactly (see isOldPerSliceEmailId).
 */

import { createClient } from '@supabase/supabase-js'

// ── Pure classifier (unit-tested in __tests__/per-slice-email-id.test.ts) ─────

const OLD_GMAIL_SLICE = /^gmail:[^:]+:\d+$/        // gmail:{msgId}:{idx}
const OLD_OUTLOOK_SLICE = /^ms_email_[^:]+:\d+$/   // ms_email_{id}:{idx}

/**
 * True only for OLD per-slice email external_ids. Must NOT match the new schemes:
 *   gmail:{id}              (P3-5 one-chunk-per-email)
 *   gmail:{id}:ical:{n}     (P3-9 calendar record)
 *   gmail:thread:{id}       (P3-8 thread parent)
 *   ms_email_{id}, ms_email:thread:{id}
 */
export function isOldPerSliceEmailId(externalId: string): boolean {
  return OLD_GMAIL_SLICE.test(externalId) || OLD_OUTLOOK_SLICE.test(externalId)
}

// ── Script (skipped when imported by tests) ───────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const opt = (n: string) => {
    const i = args.indexOf(n)
    return i >= 0 ? args[i + 1] : undefined
  }
  const orgId = opt('--org')
  const execute = args.includes('--execute')
  const batchSize = Number(opt('--batch') ?? '200')

  if (!orgId) {
    console.error('Usage: npx tsx scripts/migrations/delete-per-slice-emails.ts --org <org_id> [--execute] [--batch 200]')
    process.exit(1)
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  )

  console.log(`[delete-per-slice-emails] org=${orgId} mode=${execute ? 'EXECUTE' : 'DRY-RUN'}`)

  const PAGE = 1000
  let from = 0
  let scanned = 0
  const toDelete: string[] = []
  const samples: string[] = []

  // Page through candidate docs (coarse prefix), classify precisely in JS.
  for (;;) {
    const { data, error } = await supabase
      .from('documents')
      .select('id, external_id')
      .eq('org_id', orgId)
      .or('external_id.like.gmail:%,external_id.like.ms_email_%')
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[delete-per-slice-emails] query failed:', error.message)
      process.exit(1)
    }
    if (!data || data.length === 0) break
    scanned += data.length
    for (const row of data as { id: string; external_id: string }[]) {
      if (isOldPerSliceEmailId(row.external_id)) {
        toDelete.push(row.id)
        if (samples.length < 10) samples.push(row.external_id)
      }
    }
    if (data.length < PAGE) break
    from += PAGE
  }

  console.log(`[delete-per-slice-emails] scanned ${scanned} candidate docs; ${toDelete.length} match the old per-slice scheme`)
  if (samples.length > 0) console.log('  sample external_ids:', samples.join(', '))

  if (!execute) {
    console.log('[delete-per-slice-emails] DRY-RUN — nothing deleted. Re-run with --execute (after a staging drill) to delete, then trigger a mailbox sync to re-index.')
    return
  }

  let deleted = 0
  for (let i = 0; i < toDelete.length; i += batchSize) {
    const ids = toDelete.slice(i, i + batchSize)
    const { error } = await supabase.from('documents').delete().eq('org_id', orgId).in('id', ids)
    if (error) {
      console.error(`[delete-per-slice-emails] delete batch failed at ${i}:`, error.message)
      process.exit(1)
    }
    deleted += ids.length
    console.log(`  deleted ${deleted}/${toDelete.length}`)
  }
  console.log(`[delete-per-slice-emails] done — deleted ${deleted} per-slice email docs (embeddings cascaded). Trigger a mailbox sync to re-index under the one-chunk-per-email scheme.`)
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && process.argv[1].includes('delete-per-slice-emails')) {
  main().catch((err) => {
    console.error('[delete-per-slice-emails] fatal:', err)
    process.exit(1)
  })
}
