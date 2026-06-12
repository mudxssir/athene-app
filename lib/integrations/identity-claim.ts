// ============================================================
// lib/integrations/identity-claim.ts — org_member_identities auto-claim (P2-4)
//
// Populates the identity table at sync time: when a fetcher emits a
// StructuredOwner whose provider_email exactly matches an org member's
// email, the (member ↔ provider account) mapping is recorded. This is
// the confidence-1 ingestion path; ambiguous matches are left for the
// admin confirm/merge UI (future ticket).
//
// Never throws and never blocks indexing — failures are logged and
// swallowed. No emails or names are written to logs.
// ============================================================

// SERVICE-ROLE JUSTIFICATION: runs inside background sync (QStash worker
// context, no user RLS session). Reads org_members (id, email) scoped by
// org_id and writes org_member_identities rows for that same org only.
import { supabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import type { StructuredOwner } from './base'

// Per-org member email map, cached for the duration of a sync run.
const MEMBER_CACHE_TTL_MS = 5 * 60 * 1000
const _memberEmailCache = new Map<string, { byEmail: Map<string, string>; fetchedAt: number }>()

// Claims already written this process — avoids re-upserting the same
// mapping for every document in a sync batch.
const _claimedThisProcess = new Set<string>()

async function getMemberEmailMap(orgId: string): Promise<Map<string, string>> {
  const cached = _memberEmailCache.get(orgId)
  if (cached && Date.now() - cached.fetchedAt < MEMBER_CACHE_TTL_MS) {
    return cached.byEmail
  }
  const byEmail = new Map<string, string>()
  const { data, error } = await supabaseAdmin
    .from('org_members')
    .select('id, email')
    .eq('org_id', orgId)
  if (error) {
    logger.warn({ orgId, err: error.message }, '[identity-claim] org_members lookup failed (non-fatal)')
    return byEmail
  }
  for (const row of data ?? []) {
    const email = (row.email as string | null)?.trim().toLowerCase()
    if (email) byEmail.set(email, row.id as string)
  }
  _memberEmailCache.set(orgId, { byEmail, fetchedAt: Date.now() })
  return byEmail
}

/**
 * Records identity mappings for owners whose provider_email exactly matches
 * an org member's email. Fire-and-forget safe: never throws.
 */
export async function claimIdentitiesFromOwners(
  orgId: string,
  provider: string,
  owners: StructuredOwner[],
): Promise<void> {
  try {
    const candidates = owners.filter((o) => o.provider_email && o.provider_account_id)
    if (candidates.length === 0) return

    const byEmail = await getMemberEmailMap(orgId)
    if (byEmail.size === 0) return

    const rows: Array<Record<string, unknown>> = []
    for (const owner of candidates) {
      const email = owner.provider_email!.trim().toLowerCase()
      const memberId = byEmail.get(email)
      if (!memberId) continue

      const claimKey = `${orgId}:${provider}:${owner.provider_account_id}`
      if (_claimedThisProcess.has(claimKey)) continue
      _claimedThisProcess.add(claimKey)

      rows.push({
        org_id: orgId,
        member_id: memberId,
        provider,
        external_id: owner.provider_account_id,
        external_email: email,
        display_name: owner.person_label || null,
      })
    }
    if (rows.length === 0) return

    const { error } = await supabaseAdmin
      .from('org_member_identities')
      .upsert(rows, { onConflict: 'org_id,provider,external_id' })
    if (error) {
      logger.warn({ orgId, provider, count: rows.length, err: error.message }, '[identity-claim] upsert failed (non-fatal)')
    } else {
      logger.info({ orgId, provider, claimed: rows.length }, '[identity-claim] identities auto-claimed')
    }
  } catch (err) {
    logger.warn(
      { orgId, provider, err: err instanceof Error ? err.message : String(err) },
      '[identity-claim] failed (non-fatal)'
    )
  }
}

/** Test helper: reset module caches. */
export function _resetIdentityClaimCache(): void {
  _memberEmailCache.clear()
  _claimedThisProcess.clear()
}
