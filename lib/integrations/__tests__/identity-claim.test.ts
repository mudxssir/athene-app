// P2-4 identity auto-claim: provider_email exactly matching an org member's
// email writes an org_member_identities row at sync time. Confidence-1 only;
// no match → no write; failures never throw.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  members: [] as Array<{ id: string; email: string | null }>,
  membersError: null as { message: string } | null,
  upserts: [] as Array<Record<string, unknown>[]>,
  upsertError: null as { message: string } | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => {
      if (table === 'org_members') {
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: h.membersError ? null : h.members, error: h.membersError }),
        })
        return b
      }
      if (table === 'org_member_identities') {
        return {
          upsert: vi.fn((rows: Record<string, unknown>[]) => {
            h.upserts.push(rows)
            return Promise.resolve({ data: null, error: h.upsertError })
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { claimIdentitiesFromOwners, _resetIdentityClaimCache } from '../identity-claim'
import type { StructuredOwner } from '../base'

const ORG = 'org-1'

function owner(overrides: Partial<StructuredOwner> = {}): StructuredOwner {
  return {
    person_label: 'Alice Smith',
    provider_account_id: 'alice-gh',
    provider_email: 'alice@acme.com',
    relation: 'OWNS',
    ...overrides,
  }
}

beforeEach(() => {
  _resetIdentityClaimCache()
  h.members = [{ id: 'member-alice', email: 'alice@acme.com' }]
  h.membersError = null
  h.upserts.length = 0
  h.upsertError = null
})

describe('claimIdentitiesFromOwners', () => {
  it('claims an identity when provider_email matches a member email', async () => {
    await claimIdentitiesFromOwners(ORG, 'github', [owner()])

    expect(h.upserts).toHaveLength(1)
    expect(h.upserts[0][0]).toMatchObject({
      org_id: ORG,
      member_id: 'member-alice',
      provider: 'github',
      external_id: 'alice-gh',
      external_email: 'alice@acme.com',
      display_name: 'Alice Smith',
    })
  })

  it('matches case-insensitively and trims whitespace', async () => {
    await claimIdentitiesFromOwners(ORG, 'jira', [owner({ provider_email: '  Alice@ACME.com ' })])
    expect(h.upserts).toHaveLength(1)
    expect(h.upserts[0][0]).toMatchObject({ external_email: 'alice@acme.com' })
  })

  it('does not claim when no member email matches (left for admin UI)', async () => {
    await claimIdentitiesFromOwners(ORG, 'github', [owner({ provider_email: 'stranger@other.com' })])
    expect(h.upserts).toHaveLength(0)
  })

  it('skips owners without provider_email or provider_account_id', async () => {
    await claimIdentitiesFromOwners(ORG, 'github', [
      owner({ provider_email: undefined }),
      owner({ provider_account_id: undefined }),
    ])
    expect(h.upserts).toHaveLength(0)
  })

  it('claims each (provider, account) only once per process', async () => {
    await claimIdentitiesFromOwners(ORG, 'github', [owner()])
    await claimIdentitiesFromOwners(ORG, 'github', [owner()])
    expect(h.upserts).toHaveLength(1)
  })

  it('never throws when the member lookup fails', async () => {
    h.membersError = { message: 'db down' }
    await expect(claimIdentitiesFromOwners(ORG, 'github', [owner()])).resolves.toBeUndefined()
    expect(h.upserts).toHaveLength(0)
  })

  it('never throws when the upsert fails', async () => {
    h.upsertError = { message: 'conflict' }
    await expect(claimIdentitiesFromOwners(ORG, 'github', [owner()])).resolves.toBeUndefined()
  })
})
