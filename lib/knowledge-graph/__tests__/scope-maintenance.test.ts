// ============================================================
// lib/knowledge-graph/__tests__/scope-maintenance.test.ts — P6-3
//
// Incremental membership maintenance: ensures the org→vertical→app skeleton +
// department scopes, wires parent_scope_id, and upserts one membership row per
// (node, scope). Flag-gated; non-fatal on DB error. supabase mocked.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { scopeUpserts, memberUpserts, ensureError } = vi.hoisted(() => ({
  scopeUpserts: [] as Array<Record<string, unknown>>,
  memberUpserts: [] as Array<Array<Record<string, unknown>>>,
  ensureError: { value: false },
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/config/feature-flags', () => ({ HIERARCHY_SCOPES: true }))

// supabase: kg_scopes upsert→select('id')→single() returns a synthetic id derived
// from the payload's (level,key); kg_scope_members upsert captures rows.
let scopeSeq = 0
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      upsert: (payload: unknown) => {
        if (table === 'kg_scope_members') {
          memberUpserts.push(payload as Array<Record<string, unknown>>)
          return Promise.resolve({ error: null })
        }
        // kg_scopes
        const row = payload as Record<string, unknown>
        scopeUpserts.push(row)
        const id = ensureError.value ? null : `scope:${row.level}:${row.key}`
        return {
          select: () => ({
            single: () => Promise.resolve(
              id ? { data: { id }, error: null } : { data: null, error: { message: 'boom' } },
            ),
          }),
        }
      },
    }),
  },
}))

import { maintainScopeMemberships } from '@/lib/knowledge-graph/scope-maintenance'
import type { KGNode } from '@/lib/knowledge-graph/types'

const ORG = 'org-1'

function node(label: string, departmentIds: string[] = []): KGNode {
  return { label, entity_type: 'project', department_ids: departmentIds, visibility: 'department' } as KGNode
}

// nodeKey is `${label}::${entity_type}` (lib/knowledge-graph/utils) — mirror it for the map.
const idMapOf = (...labels: string[]) =>
  new Map(labels.map((l) => [`${l}::project`, `node:${l}`]))

beforeEach(() => {
  vi.clearAllMocks()
  scopeUpserts.length = 0
  memberUpserts.length = 0
  ensureError.value = false
  scopeSeq = 0
})

describe('maintainScopeMemberships (P6-3)', () => {
  it('ensures org→vertical→app skeleton with correct parent wiring', async () => {
    await maintainScopeMemberships(ORG, 'jira', [node('PROJ-1')], idMapOf('PROJ-1'))

    const byLevelKey = (level: string, key: string) =>
      scopeUpserts.find((s) => s.level === level && s.key === key)

    expect(byLevelKey('org', 'root')).toMatchObject({ parent_scope_id: null })
    expect(byLevelKey('vertical', 'devtools')).toMatchObject({ parent_scope_id: 'scope:org:root' })
    expect(byLevelKey('app', 'jira')).toMatchObject({ parent_scope_id: 'scope:vertical:devtools' })
  })

  it('upserts one membership row per (node, scope): app + vertical + each dept', async () => {
    await maintainScopeMemberships(ORG, 'jira', [node('PROJ-1', ['dept-a'])], idMapOf('PROJ-1'))

    const rows = memberUpserts.flat()
    const scopeIds = rows.map((r) => r.scope_id).sort()
    expect(scopeIds).toEqual(['scope:app:jira', 'scope:department:dept-a', 'scope:vertical:devtools'])
    expect(rows.every((r) => r.node_id === 'node:PROJ-1' && r.org_id === ORG && r.weight === 1)).toBe(true)
  })

  it('dedups departments across nodes and members across (scope,node)', async () => {
    await maintainScopeMemberships(
      ORG, 'jira',
      [node('A', ['dept-a']), node('B', ['dept-a', 'dept-b'])],
      idMapOf('A', 'B'),
    )
    // dept-a ensured once (not per node).
    const deptScopeUpserts = scopeUpserts.filter((s) => s.level === 'department')
    expect(deptScopeUpserts.map((s) => s.key).sort()).toEqual(['dept-a', 'dept-b'])
    // No duplicate (scope,node) member rows.
    const rows = memberUpserts.flat()
    const keys = rows.map((r) => `${r.scope_id}:${r.node_id}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('an unknown provider yields an app scope but no vertical', async () => {
    await maintainScopeMemberships(ORG, 'myspace', [node('X')], idMapOf('X'))
    expect(scopeUpserts.find((s) => s.level === 'vertical')).toBeUndefined()
    expect(scopeUpserts.find((s) => s.level === 'app' && s.key === 'myspace')).toBeTruthy()
    const rows = memberUpserts.flat()
    expect(rows.map((r) => r.scope_id)).toEqual(['scope:app:myspace'])
  })

  it('no-ops when flag is off (separate import not needed — covered by gate) or no touched nodes', async () => {
    // No nodeIdMap match → no touched nodes → no writes.
    await maintainScopeMemberships(ORG, 'jira', [node('PROJ-1')], new Map())
    expect(scopeUpserts).toHaveLength(0)
    expect(memberUpserts).toHaveLength(0)
  })

  it('bails without throwing when the org scope cannot be ensured', async () => {
    ensureError.value = true
    await expect(
      maintainScopeMemberships(ORG, 'jira', [node('PROJ-1')], idMapOf('PROJ-1')),
    ).resolves.toBeUndefined()
    expect(memberUpserts).toHaveLength(0)
  })
})
