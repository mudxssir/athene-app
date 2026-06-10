// ============================================================
// graph-query.test.ts — Unit tests for ATH-62 graph query tool
//
// Mocks:
//   - @langchain/openai (ChatOpenAI) → controlled entity extraction
//   - @/lib/supabase/rls-client (withRLS) → controlled DB reads
//   - ./registry → no-op registerTool to avoid side effects
// ============================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockMiniInvoke } = vi.hoisted(() => ({
  mockMiniInvoke: vi.fn(),
}))

vi.mock('@/lib/langgraph/llm-factory', () => ({
  resolveModelClient: vi.fn().mockResolvedValue({
    invoke: mockMiniInvoke,
  }),
}))

// ---- Mock registry ------------------------------------------

vi.mock('@/lib/langgraph/tools/registry', () => ({
  registerTool: vi.fn(),
  toolsRegistry: [],
}))

// ---- Mock supabaseAdmin -------------------------------------

const {
  mockFrom,
  mockSelect,
  mockEq,
  mockIn,
  mockOr,
  mockLimit,
  mockSingle,
  chainable,
} = vi.hoisted(() => {
  const mockFrom = vi.fn()
  const mockSelect = vi.fn()
  const mockEq = vi.fn()
  const mockIn = vi.fn()
  const mockOr = vi.fn()
  const mockLimit = vi.fn()
  const mockSingle = vi.fn()

  const chainable = {
    select: mockSelect,
    eq: mockEq,
    in: mockIn,
    or: mockOr,
    limit: mockLimit,
    single: mockSingle,
  }

  // Make every method return `chainable` so calls can be chained
  Object.values(chainable).forEach((fn) => fn.mockReturnValue(chainable))
  mockFrom.mockReturnValue(chainable)

  return {
    mockFrom,
    mockSelect,
    mockEq,
    mockIn,
    mockOr,
    mockLimit,
    mockSingle,
    chainable,
  }
})

vi.mock('@/lib/supabase/rls-client', () => ({
  withRLS: vi.fn(async (_ctx: unknown, cb: (c: unknown) => Promise<unknown>) =>
    cb({
      from: mockFrom,
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  ),
}))

// ---- Import after mocks ------------------------------------

import { graphQueryTool } from '@/lib/langgraph/tools/graph-query'

// ---- Helpers ------------------------------------------------

function makeConfig(orgId: string, role: string) {
  return { configurable: { orgId, userId: 'user-1', role } }
}

function fakeLLMResponse(content: string) {
  return { content }
}

// ---- Tests --------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Default: every chainable returns empty data
  mockLimit.mockResolvedValue({ data: [], error: null })
  mockSingle.mockResolvedValue({ data: null, error: null })
})

describe('graphQueryTool — entity extraction', () => {
  it('returns graceful message when LLM finds no entities', async () => {
    mockMiniInvoke.mockResolvedValue(fakeLLMResponse('[]'))

    const result = await graphQueryTool.invoke(
      { question: 'tell me something random', maxHops: 2 },
      makeConfig('org-1', 'member'),
    )

    expect(result).toBe(
      'No entities found in your question to look up in the knowledge graph.',
    )
  })

  it('returns graceful message when LLM throws', async () => {
    mockMiniInvoke.mockRejectedValue(new Error('timeout'))

    // findNodes won't be reached (labels=[]), so limit is never called with nodes
    const result = await graphQueryTool.invoke(
      { question: 'who owns the billing service?', maxHops: 2 },
      makeConfig('org-1', 'member'),
    )

    expect(result).toBe(
      'No entities found in your question to look up in the knowledge graph.',
    )
  })

  it('returns graceful message when no matching nodes in DB', async () => {
    mockMiniInvoke.mockResolvedValue(fakeLLMResponse('["BillingService"]'))
    mockLimit.mockResolvedValue({ data: [], error: null })

    const result = await graphQueryTool.invoke(
      { question: 'who owns BillingService?', maxHops: 2 },
      makeConfig('org-1', 'member'),
    )

    expect(result).toBe('No knowledge graph data available yet.')
  })
})

describe('graphQueryTool — visibility gating', () => {
  const seedNode = {
    id: 'node-1',
    label: 'BillingService',
    entity_type: 'service',
    visibility: 'public',
    department_ids: ['eng'],
    description: 'Handles billing',
  }

  beforeEach(() => {
    mockMiniInvoke.mockResolvedValue(fakeLLMResponse('["BillingService"]'))
    // First limit call returns the seed node
    mockLimit
      .mockResolvedValueOnce({ data: [seedNode], error: null }) // findNodes
      .mockResolvedValueOnce({ data: [], error: null })          // edges BFS
    mockSingle.mockResolvedValue({ data: seedNode, error: null })
  })

  it('non-BI role queries with visibility=org_wide filter', async () => {
    await graphQueryTool.invoke(
      { question: 'what is BillingService?', maxHops: 1 },
      makeConfig('org-1', 'member'),
    )

    // Should have applied .eq('visibility', 'org_wide')
    expect(mockEq).toHaveBeenCalledWith('visibility', 'org_wide')
  })

  it('bi_analyst role does NOT filter by visibility', async () => {
    await graphQueryTool.invoke(
      { question: 'what is BillingService?', maxHops: 1 },
      makeConfig('org-1', 'bi_analyst'),
    )

    const visibilityCalls = mockEq.mock.calls.filter(
      ([col]) => col === 'visibility',
    )
    expect(visibilityCalls).toHaveLength(0)
  })
})

describe('graphQueryTool — traversal and formatting', () => {
  const nodeA = {
    id: 'node-a',
    label: 'ServiceA',
    entity_type: 'service',
    visibility: 'public',
    department_ids: ['eng'],
    description: null,
  }

  const edge = {
    source_node: 'node-a',
    target_node: 'node-b',
    relation: 'DEPENDS_ON',
    provenance: 'EXTRACTED',
    confidence: 0.9,
  }

  it('formats entities and relationships in output', async () => {
    mockMiniInvoke.mockResolvedValue(fakeLLMResponse('["ServiceA"]'))

    // findNodes returns nodeA
    mockLimit
      .mockResolvedValueOnce({ data: [nodeA], error: null })  // findNodes
      .mockResolvedValueOnce({ data: [edge], error: null })   // BFS edges from node-a
      .mockResolvedValueOnce({ data: [], error: null })       // BFS edges from node-b
    mockSingle
      .mockResolvedValueOnce({ data: nodeA, error: null })    // fetch node-a in BFS
      .mockResolvedValueOnce({ data: null, error: null })     // fetch node-b (not found)

    const result = await graphQueryTool.invoke(
      { question: 'tell me about ServiceA', maxHops: 2 },
      makeConfig('org-1', 'bi_analyst'),
    )

    expect(result).toContain('ServiceA')
    expect(result).toContain('DEPENDS_ON')
  })

  it('returns graceful message when no org context', async () => {
    const result = await graphQueryTool.invoke(
      { question: 'what?', maxHops: 2 },
      {},
    )
    expect(result).toBe('Knowledge graph unavailable: missing org context.')
  })
})

describe('graphQueryTool — error resilience', () => {
  it('catches DB errors and returns graceful message', async () => {
    mockMiniInvoke.mockResolvedValue(fakeLLMResponse('["CrashService"]'))
    mockLimit.mockResolvedValue({ data: null, error: { message: 'DB down' } })

    const result = await graphQueryTool.invoke(
      { question: 'what is CrashService?', maxHops: 2 },
      makeConfig('org-1', 'member'),
    )

    // findNodes throws, caught by top-level try/catch
    expect(result).toBe('No knowledge graph data available yet.')
  })
})
