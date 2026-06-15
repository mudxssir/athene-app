// ============================================================
// lib/knowledge-graph/__tests__/scope-summary-prompt.test.ts — P6-6
//
// Pure prompt + highlights parsing: prompt structure (entities/relations/blockers/
// child reports + cross-scope nudge), and robust JSON parsing/clamping.
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  buildScopeSummaryPrompt,
  parseScopeHighlights,
  SCOPE_SUMMARY_SCHEMA_HINT,
} from '@/lib/knowledge-graph/prompts/scope-summary'

const ctx = (level: string) => ({
  level,
  title: 'Engineering',
  members: [{ label: 'API Gateway', entity_type: 'service', description: 'edge router' }],
  relations: [{ from: 'API Gateway', to: 'Billing', relation: 'DEPENDS_ON' }],
  blockers: [{ from: 'Billing', to: 'API Gateway', relation: 'BLOCKS' }],
  childSummaries: [{ title: 'Cluster 1', overview: 'auth + sessions' }],
})

describe('buildScopeSummaryPrompt (P6-6)', () => {
  it('includes entities, relations, blockers, and child reports + the schema', () => {
    const p = buildScopeSummaryPrompt(ctx('app'))
    expect(p).toContain('API Gateway [service]: edge router')
    expect(p).toContain('API Gateway —DEPENDS_ON→ Billing')
    expect(p).toContain('Billing —BLOCKS→ API Gateway')
    expect(p).toContain('Cluster 1')
    expect(p).toContain(SCOPE_SUMMARY_SCHEMA_HINT)
  })

  it('adds the cross-scope nudge only at vertical/org levels', () => {
    expect(buildScopeSummaryPrompt(ctx('org'))).toContain('cross_scope_links')
    expect(buildScopeSummaryPrompt(ctx('vertical'))).toContain('bridge this scope')
    expect(buildScopeSummaryPrompt(ctx('app'))).not.toContain('bridge this scope')
  })

  it('renders empty sections without throwing', () => {
    const p = buildScopeSummaryPrompt({ level: 'app', title: 'X', members: [], relations: [], blockers: [], childSummaries: [] })
    expect(p).toContain('(none)')
  })
})

describe('parseScopeHighlights (P6-6)', () => {
  const valid = JSON.stringify({
    overview: 'Engineering is shipping the billing migration.',
    key_entities: ['API Gateway', 'Billing', 42],
    active_blockers: [{ from: 'Billing', to: 'API Gateway', owner: 'Dana', age: '3d' }],
    recent_decisions: ['Adopt v2 schema'],
    open_obligations: ['Migrate prod'],
    cross_scope_links: [{ other_scope: 'Sales', via_entities: ['Billing'] }],
    rating: 8,
  })

  it('parses a clean JSON report and sanitizes arrays', () => {
    const h = parseScopeHighlights(valid)!
    expect(h.overview).toContain('billing migration')
    expect(h.key_entities).toEqual(['API Gateway', 'Billing']) // non-string filtered
    expect(h.active_blockers[0]).toEqual({ from: 'Billing', to: 'API Gateway', owner: 'Dana', age: '3d' })
    expect(h.cross_scope_links[0]).toEqual({ other_scope: 'Sales', via_entities: ['Billing'] })
    expect(h.rating).toBe(8)
  })

  it('extracts JSON from a fenced block and from noisy prose', () => {
    expect(parseScopeHighlights('```json\n' + valid + '\n```')?.rating).toBe(8)
    expect(parseScopeHighlights('Sure! Here:\n' + valid + '\nDone.')?.rating).toBe(8)
  })

  it('clamps rating to 1..10 and defaults non-numeric', () => {
    expect(parseScopeHighlights(JSON.stringify({ overview: 'x', rating: 99 }))?.rating).toBe(10)
    expect(parseScopeHighlights(JSON.stringify({ overview: 'x', rating: 0 }))?.rating).toBe(1)
    expect(parseScopeHighlights(JSON.stringify({ overview: 'x', rating: 'high' }))?.rating).toBe(1)
  })

  it('returns null without an overview or on garbage', () => {
    expect(parseScopeHighlights(JSON.stringify({ key_entities: ['a'] }))).toBeNull()
    expect(parseScopeHighlights('not json at all')).toBeNull()
    expect(parseScopeHighlights('')).toBeNull()
  })
})
