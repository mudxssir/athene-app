// ============================================================
// lib/integrations/__tests__/structured-metadata-refresh.test.ts
//
// structuredMetadataChanged — the guard that lets a re-sync backfill new
// fetcher-emitted KG metadata (structured_owners / structured_account) onto a
// doc whose CONTENT is unchanged (content-hash dedup would otherwise swallow it).
// Only the KG-relevant keys are compared, so volatile fields don't churn.
// ============================================================

import { describe, it, expect } from 'vitest'
import { structuredMetadataChanged } from '@/lib/integrations/indexing'

describe('structuredMetadataChanged', () => {
  const owners = [{ person_label: 'octocat', relation: 'OWNS' }]

  it('detects when structured_owners is newly added (the backfill case)', () => {
    // Stored doc has no owners (indexed before the owner-graph fetcher); the new
    // fetch emits them → must refresh + re-extract.
    expect(structuredMetadataChanged({ provider: 'github', resource_type: 'issue' }, { provider: 'github', resource_type: 'issue', structured_owners: owners })).toBe(true)
  })

  it('detects when structured_owners changes value', () => {
    expect(structuredMetadataChanged(
      { structured_owners: owners },
      { structured_owners: [{ person_label: 'someone-else', relation: 'OWNS' }] },
    )).toBe(true)
  })

  it('detects when structured_account is newly added (CRM edges)', () => {
    expect(structuredMetadataChanged({ provider: 'salesforce' }, { provider: 'salesforce', structured_account: 'Acme Corp' })).toBe(true)
  })

  it('returns false when KG metadata is identical (no needless re-extraction)', () => {
    expect(structuredMetadataChanged({ structured_owners: owners }, { structured_owners: owners })).toBe(false)
    expect(structuredMetadataChanged({}, {})).toBe(false)
  })

  it('ignores volatile non-KG fields (last_modified ticking must NOT trigger churn)', () => {
    expect(structuredMetadataChanged(
      { structured_owners: owners, last_modified: '2026-06-15T10:00:00Z' },
      { structured_owners: owners, last_modified: '2026-06-16T11:00:00Z' },
    )).toBe(false)
  })

  it('treats null/undefined stored metadata as "no KG keys" (first-ever index)', () => {
    expect(structuredMetadataChanged(null, { structured_owners: owners })).toBe(true)
    expect(structuredMetadataChanged(undefined, { provider: 'x' })).toBe(false)
  })
})
