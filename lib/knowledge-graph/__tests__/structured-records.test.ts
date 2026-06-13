// ============================================================
// lib/knowledge-graph/__tests__/structured-records.test.ts — P4-7
//
// CRM deterministic field edges: owner → OWNS → record, record →
// TIED_TO_ACCOUNT → account. Plus the crmStructuredMetadata emission helper.
// ============================================================

import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { crmStructuredMetadata } from '@/lib/integrations/crm-structured'
import { buildStructuredRecordGraph } from '@/lib/knowledge-graph/structured-records'

const base = {
  id: 'doc-1',
  org_id: 'org-1',
  department_id: null,
  visibility: 'org_wide',
}

describe('crmStructuredMetadata (P4-7 emission)', () => {
  it('emits structured_owners (OWNS) + structured_account', () => {
    const m = crmStructuredMetadata({ ownerName: 'Dana Lee', accountName: 'Acme Corp' })
    expect(m.structured_owners).toEqual([{ person_label: 'Dana Lee', relation: 'OWNS' }])
    expect(m.structured_account).toBe('Acme Corp')
  })

  it('carries email + account id when present', () => {
    const m = crmStructuredMetadata({ ownerName: 'Dana', ownerEmail: 'dana@acme.com', ownerAccountId: '005x' })
    expect(m.structured_owners![0]).toEqual({
      person_label: 'Dana',
      relation: 'OWNS',
      provider_email: 'dana@acme.com',
      provider_account_id: '005x',
    })
  })

  it('omits keys when fields are blank/absent', () => {
    expect(crmStructuredMetadata({})).toEqual({})
    expect(crmStructuredMetadata({ ownerName: '   ' })).toEqual({})
    expect(crmStructuredMetadata({ accountName: 'Acme' })).toEqual({ structured_account: 'Acme' })
  })
})

describe('buildStructuredRecordGraph (P4-7)', () => {
  it('opportunity: owner→OWNS→deal + deal→TIED_TO_ACCOUNT→account, all EXTRACTED/1.0', () => {
    const { nodes, edges } = buildStructuredRecordGraph({
      ...base,
      title: 'Acme Renewal',
      metadata: {
        resource_type: 'opportunities',
        structured_owners: [{ person_label: 'Dana Lee', relation: 'OWNS' }],
        structured_account: 'Acme Corp',
      },
    })

    const self = nodes.find((n) => n.label === 'Acme Renewal')!
    expect(self.entity_type).toBe('deal')
    expect(nodes.find((n) => n.label === 'Dana Lee')?.entity_type).toBe('person')
    expect(nodes.find((n) => n.label === 'Acme Corp')?.entity_type).toBe('account')

    const owns = edges.find((e) => e.relation === 'OWNS')!
    expect(owns.source_label).toBe('Dana Lee')
    expect(owns.target_label).toBe('Acme Renewal')
    expect(owns.provenance).toBe('EXTRACTED')
    expect(owns.confidence).toBe(1.0)

    const tied = edges.find((e) => e.relation === 'TIED_TO_ACCOUNT')!
    expect(tied.source_label).toBe('Acme Renewal')
    expect(tied.target_label).toBe('Acme Corp')
    expect(tied.confidence).toBe(1.0)
  })

  it('account record: owner→OWNS only, no self-referential TIED_TO_ACCOUNT', () => {
    const { nodes, edges } = buildStructuredRecordGraph({
      ...base,
      title: 'Acme Corp',
      metadata: {
        resource_type: 'accounts',
        structured_owners: [{ person_label: 'Dana Lee', relation: 'OWNS' }],
        // no structured_account
      },
    })
    expect(nodes.find((n) => n.label === 'Acme Corp')?.entity_type).toBe('account')
    expect(edges.some((e) => e.relation === 'OWNS')).toBe(true)
    expect(edges.some((e) => e.relation === 'TIED_TO_ACCOUNT')).toBe(false)
  })

  it('visibility split: record + edges inherit doc visibility; person/account org_wide', () => {
    const { nodes, edges } = buildStructuredRecordGraph({
      ...base,
      visibility: 'department',
      department_id: 'dept-x',
      title: 'Big Deal',
      metadata: {
        resource_type: 'opportunities',
        structured_owners: [{ person_label: 'Dana', relation: 'OWNS' }],
        structured_account: 'Acme',
      },
    })
    expect(nodes.find((n) => n.label === 'Big Deal')?.visibility).toBe('department')
    expect(nodes.find((n) => n.label === 'Dana')?.visibility).toBe('org_wide')
    expect(nodes.find((n) => n.label === 'Acme')?.visibility).toBe('org_wide')
    expect(edges.every((e) => e.visibility === 'department')).toBe(true)
  })

  it('returns empty when no owner/account or no title', () => {
    expect(buildStructuredRecordGraph({ ...base, title: 'X', metadata: { resource_type: 'opportunities' } }).nodes).toHaveLength(0)
    expect(
      buildStructuredRecordGraph({ ...base, title: null, metadata: { structured_account: 'Acme' } }).nodes,
    ).toHaveLength(0)
  })

  it('ignores non-OWNS owner relations (records only carry OWNS)', () => {
    const { edges } = buildStructuredRecordGraph({
      ...base,
      title: 'Deal',
      metadata: {
        resource_type: 'deals',
        structured_owners: [{ person_label: 'Dana', relation: 'WORKS_ON' }],
      },
    })
    expect(edges.some((e) => e.relation === 'OWNS')).toBe(false)
  })
})
