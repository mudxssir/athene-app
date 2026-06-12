// P2-10: Tier-B chain — regex → sidecar GLiNER confirm → LLM.
// Chain verdicts under test:
//   regex negative                    → B / skip (GLiNER never called)
//   regex positive + GLiNER entities  → A / run
//   regex positive + GLiNER empty     → B / skip (false positive cut)
//   regex positive + sidecar down     → A / run (fail open)
// Non-thread shapes and Tier-A sources never touch GLiNER.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  available: true,
  glinerResult: null as { entities: Array<{ text: string; label: string; score: number; text_index: number }>; model_version: string; duration_ms: number } | null,
  glinerCalls: [] as string[][],
}))

vi.mock('@/lib/integrations/sidecar-client', () => ({
  sidecarAvailable: () => h.available,
  glinerExtract: vi.fn(async (texts: string[]) => {
    h.glinerCalls.push(texts)
    return h.glinerResult
  }),
}))

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import {
  extractionTierChained,
  shouldRunExtractionChained,
} from '../extraction-gate'

const NO_SIGNAL = ['just a routine status update, everything is fine']
const WITH_SIGNAL = ['we decided to postpone the launch until Q3']
const ENTITIES = {
  entities: [{ text: 'Q3 Launch', label: 'project', score: 0.9, text_index: 0 }],
  model_version: 'stub',
  duration_ms: 5,
}
const NO_ENTITIES = { entities: [], model_version: 'stub', duration_ms: 5 }

beforeEach(() => {
  h.available = true
  h.glinerResult = ENTITIES
  h.glinerCalls.length = 0
})

describe('extractionTierChained (thread shape)', () => {
  it('regex negative → B, GLiNER never called', async () => {
    expect(await extractionTierChained('thread', NO_SIGNAL)).toBe('B')
    expect(h.glinerCalls).toHaveLength(0)
  })

  it('regex positive + GLiNER entities → A', async () => {
    h.glinerResult = ENTITIES
    expect(await extractionTierChained('thread', WITH_SIGNAL)).toBe('A')
    expect(h.glinerCalls).toHaveLength(1)
  })

  it('regex positive + GLiNER empty → B (false positive cut)', async () => {
    h.glinerResult = NO_ENTITIES
    expect(await extractionTierChained('thread', WITH_SIGNAL)).toBe('B')
  })

  it('regex positive + sidecar unconfigured → A (fail open)', async () => {
    h.available = false
    expect(await extractionTierChained('thread', WITH_SIGNAL)).toBe('A')
    expect(h.glinerCalls).toHaveLength(0)
  })

  it('regex positive + GLiNER error (null) → A (fail open)', async () => {
    h.glinerResult = null
    expect(await extractionTierChained('thread', WITH_SIGNAL)).toBe('A')
  })

  it('sends only the signal-matching chunks, in ONE call', async () => {
    const texts = [...NO_SIGNAL, ...WITH_SIGNAL, 'another plain message about lunch']
    await extractionTierChained('thread', texts)
    expect(h.glinerCalls).toHaveLength(1)
    expect(h.glinerCalls[0]).toEqual(WITH_SIGNAL)
  })

  it('non-thread shapes never call GLiNER', async () => {
    expect(await extractionTierChained('prose', WITH_SIGNAL)).toBe('A')
    expect(await extractionTierChained('tabular', WITH_SIGNAL)).toBe('C')
    expect(await extractionTierChained('record', WITH_SIGNAL)).toBe('B')
    expect(h.glinerCalls).toHaveLength(0)
  })
})

describe('shouldRunExtractionChained (legacy source-type routing)', () => {
  it('Tier-A source → true without GLiNER', async () => {
    expect(await shouldRunExtractionChained('jira', NO_SIGNAL)).toBe(true)
    expect(h.glinerCalls).toHaveLength(0)
  })

  it('slack, regex negative → false without GLiNER', async () => {
    expect(await shouldRunExtractionChained('slack', NO_SIGNAL)).toBe(false)
    expect(h.glinerCalls).toHaveLength(0)
  })

  it('slack, regex positive + entities → true', async () => {
    h.glinerResult = ENTITIES
    expect(await shouldRunExtractionChained('slack', WITH_SIGNAL)).toBe(true)
  })

  it('slack, regex positive + no entities → false', async () => {
    h.glinerResult = NO_ENTITIES
    expect(await shouldRunExtractionChained('slack', WITH_SIGNAL)).toBe(false)
  })

  it('slack, regex positive + sidecar down → true (fail open)', async () => {
    h.available = false
    expect(await shouldRunExtractionChained('slack', WITH_SIGNAL)).toBe(true)
  })
})

describe('P2-10 obligation/ownership verbs in the regex set', () => {
  const PROMOTED = [
    'this is assigned to Priya for next sprint',
    'Marcus is taking over the billing migration',
    'I am responsible for the rollout plan',
    'action item: update the runbook',
    'the report is due by Friday',
    'Dana owns the incident response process',
    'follow-up by end of week on the contract',
  ]
  for (const text of PROMOTED) {
    it(`"${text.slice(0, 40)}…" passes the regex gate`, async () => {
      h.glinerResult = ENTITIES
      expect(await extractionTierChained('thread', [text])).toBe('A')
    })
  }

  it('common possessive "their own" does NOT trip the ownership verb', async () => {
    expect(await extractionTierChained('thread', ['teams manage their own backlog grooming'])).toBe('B')
    expect(h.glinerCalls).toHaveLength(0)
  })
})
