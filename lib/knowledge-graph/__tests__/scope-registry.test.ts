// ============================================================
// lib/knowledge-graph/__tests__/scope-registry.test.ts — P6-2
//
// The scope vocabulary: provider→vertical (reusing PROVIDER_REGISTRY.category),
// stable keys/titles per level, the parent roll-up chain, and the structural
// scopes a node belongs to. Pure + deterministic.
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  ORG_SCOPE,
  verticalForProvider,
  appScope,
  verticalScope,
  departmentScope,
  communityScope,
  personScope,
  providerOfCommunityKey,
  parentScope,
  structuralScopesForNode,
} from '@/lib/knowledge-graph/scope-registry'

describe('verticalForProvider (P6-2)', () => {
  it('maps providers to their registry category (the vertical)', () => {
    expect(verticalForProvider('jira')).toBe('devtools')
    expect(verticalForProvider('github')).toBe('devtools')
    expect(verticalForProvider('salesforce')).toBe('crm')
    expect(verticalForProvider('slack')).toBe('communication')
    expect(verticalForProvider('snowflake')).toBe('data')
    expect(verticalForProvider('google_drive')).toBe('productivity')
  })

  it('returns null for an unknown provider', () => {
    expect(verticalForProvider('myspace')).toBeNull()
    expect(verticalForProvider('')).toBeNull()
  })
})

describe('scope descriptors (P6-2)', () => {
  it('app scope keys on the provider, titled by displayName', () => {
    const s = appScope('jira')
    expect(s).toMatchObject({ level: 'app', key: 'jira' })
    expect(s?.title).toBeTruthy()
    expect(appScope('')).toBeNull()
  })

  it('unknown provider still gets an app scope (key=provider), no vertical', () => {
    expect(appScope('myspace')).toMatchObject({ level: 'app', key: 'myspace', title: 'myspace' })
    expect(verticalScope('myspace')).toBeNull()
  })

  it('vertical scope keys on the category', () => {
    expect(verticalScope('salesforce')).toMatchObject({ level: 'vertical', key: 'crm' })
    expect(verticalScope('github')).toMatchObject({ level: 'vertical', key: 'devtools' })
  })

  it('department/person/community/org descriptors', () => {
    expect(departmentScope('dept-uuid', 'Engineering')).toEqual({ level: 'department', key: 'dept-uuid', title: 'Engineering' })
    expect(personScope('member-uuid', 'Dana')).toEqual({ level: 'person', key: 'member-uuid', title: 'Dana' })
    expect(communityScope('jira', 7)).toMatchObject({ level: 'community', key: 'jira#7' })
    expect(ORG_SCOPE).toEqual({ level: 'org', key: 'root', title: 'Organization' })
  })

  it('community key encodes its provider (so the parent app is derivable)', () => {
    expect(providerOfCommunityKey('jira#7')).toBe('jira')
    expect(providerOfCommunityKey('root')).toBeNull()
  })
})

describe('parentScope — roll-up chain (P6-2)', () => {
  it('community → app → vertical → org', () => {
    const community = communityScope('jira', 3)
    const app = parentScope(community)
    expect(app).toMatchObject({ level: 'app', key: 'jira' })
    const vertical = parentScope(app!)
    expect(vertical).toMatchObject({ level: 'vertical', key: 'devtools' })
    expect(parentScope(vertical!)).toEqual(ORG_SCOPE)
  })

  it('department and person roll up directly to org; org has no parent', () => {
    expect(parentScope(departmentScope('d1'))).toEqual(ORG_SCOPE)
    expect(parentScope(personScope('m1'))).toEqual(ORG_SCOPE)
    expect(parentScope(ORG_SCOPE)).toBeNull()
  })

  it('an unknown-provider app rolls up straight to org (no vertical)', () => {
    expect(parentScope(appScope('myspace')!)).toEqual(ORG_SCOPE)
  })
})

describe('structuralScopesForNode (P6-2)', () => {
  it('returns app + vertical + one scope per department', () => {
    const scopes = structuralScopesForNode({
      provider: 'jira',
      departmentIds: ['dept-a', 'dept-b'],
      departmentNames: { 'dept-a': 'Eng', 'dept-b': 'Platform' },
    })
    expect(scopes).toEqual([
      expect.objectContaining({ level: 'app', key: 'jira' }),
      expect.objectContaining({ level: 'vertical', key: 'devtools' }),
      { level: 'department', key: 'dept-a', title: 'Eng' },
      { level: 'department', key: 'dept-b', title: 'Platform' },
    ])
  })

  it('omits the vertical for an unknown provider and tolerates no departments', () => {
    const scopes = structuralScopesForNode({ provider: 'myspace' })
    expect(scopes).toEqual([expect.objectContaining({ level: 'app', key: 'myspace' })])
  })

  it('skips blank department ids', () => {
    const scopes = structuralScopesForNode({ provider: 'slack', departmentIds: ['', 'dept-x'] })
    expect(scopes.filter((s) => s.level === 'department')).toEqual([
      { level: 'department', key: 'dept-x', title: 'Department' },
    ])
  })
})
