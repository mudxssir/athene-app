// ============================================================
// lib/integrations/crm-structured.ts — P4-7
//
// Shared helper that turns the deterministic CRM fields every record fetcher
// already has (owner name/email, account name) into the metadata keys the KG
// builder consumes — `structured_owners` (owner → OWNS, reusing the P2 shape)
// and `structured_account` (record → TIED_TO_ACCOUNT). Spread the result into a
// record chunk's metadata. Keeps the per-fetcher edit to one line.
// ============================================================

import type { StructuredOwner } from './base'

export interface CrmStructuredInput {
  /** CRM record owner display name (Salesforce Owner.Name, etc.). */
  ownerName?: string | null
  /** Owner email when the provider exposes it — drives identity auto-claim (P2-4). */
  ownerEmail?: string | null
  /** Provider-native owner id when available (resolved at query time). */
  ownerAccountId?: string | null
  /** Parent account / company name (Salesforce Account.Name, etc.). */
  accountName?: string | null
}

export interface CrmStructuredMetadata {
  structured_owners?: StructuredOwner[]
  structured_account?: string
}

/**
 * Build the structured CRM metadata keys from deterministic record fields.
 * Returns an empty object when neither an owner nor an account is present, so
 * spreading it is always safe.
 */
export function crmStructuredMetadata(input: CrmStructuredInput): CrmStructuredMetadata {
  const out: CrmStructuredMetadata = {}

  const ownerName = input.ownerName?.trim()
  if (ownerName) {
    const owner: StructuredOwner = { person_label: ownerName, relation: 'OWNS' }
    if (input.ownerEmail?.trim()) owner.provider_email = input.ownerEmail.trim()
    if (input.ownerAccountId?.trim()) owner.provider_account_id = input.ownerAccountId.trim()
    out.structured_owners = [owner]
  }

  const accountName = input.accountName?.trim()
  if (accountName) out.structured_account = accountName

  return out
}
