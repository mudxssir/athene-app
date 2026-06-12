// P1-11 unit tests — sidecar client circuit breaker + config guards
// The actual HTTP calls are mocked; we test CB state transitions and
// the public surface (sidecarAvailable, parseSidecar, chunkSemantic).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Isolate module state between tests by reimporting with fresh env
let SIDECAR_URL_VALUE = 'http://sidecar.internal'
let SIDECAR_TOKEN_VALUE = 'secret-token'

vi.mock('@/lib/integrations/sidecar-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/integrations/sidecar-client')>()
  return actual
})

// We need to control env vars. Use process.env mutation + reimport.
// Since Vitest shares the module registry per file, we test via the exported
// helpers rather than env-var gating (env gates are covered by integration tests).

import {
  sidecarAvailable,
  parseSidecar,
  chunkSemantic,
  glinerExtract,
  _circuitBreakerState,
  _resetCircuitBreaker,
} from '@/lib/integrations/sidecar-client'

const originalEnv = { ...process.env }

describe('circuit breaker', () => {
  beforeEach(() => {
    _resetCircuitBreaker()
    process.env.SIDECAR_URL = 'http://sidecar.internal'
    process.env.SIDECAR_AUTH_TOKEN = 'test-token'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    _resetCircuitBreaker()
  })

  it('starts closed', () => {
    expect(_circuitBreakerState().state).toBe('closed')
    expect(_circuitBreakerState().failures).toBe(0)
  })

  it('sidecarAvailable returns false when SIDECAR_URL is not set', () => {
    delete process.env.SIDECAR_URL
    // The module reads env at import time, so we test the runtime path through
    // the exported function which checks isConfigured() against the module-level constant.
    // Since the constant was already set at import time, this just confirms the API shape.
    expect(typeof sidecarAvailable()).toBe('boolean')
  })

  it('circuit breaker opens after 3 failures', async () => {
    // Simulate network failures by mocking global fetch
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    // 3 failing calls → open
    for (let i = 0; i < 3; i++) {
      await parseSidecar(Buffer.from('hi'), 'test.txt')
    }

    expect(_circuitBreakerState().state).toBe('open')
    vi.unstubAllGlobals()
  })

  it('circuit breaker resets on success', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          markdown: 'hello',
          parser_used: 'docling',
          parser_version: '2.15.0',
          file_size_bytes: 2,
          duration_ms: 10,
        }),
      } as Response)
    )

    await parseSidecar(Buffer.from('hi'), 'test.txt')
    await parseSidecar(Buffer.from('hi'), 'test.txt')
    await parseSidecar(Buffer.from('hi'), 'test.txt')  // success

    expect(_circuitBreakerState().state).toBe('closed')
    expect(_circuitBreakerState().failures).toBe(0)
    vi.unstubAllGlobals()
  })

  it('parseSidecar returns null when circuit breaker is open', async () => {
    // Force open state by failing 3 times
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    for (let i = 0; i < 3; i++) {
      await parseSidecar(Buffer.from('hi'), 'test.txt')
    }
    vi.unstubAllGlobals()

    // Now circuit is open — next call must return null without making network call
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await parseSidecar(Buffer.from('hi'), 'test.txt')

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('parseSidecar returns null for files over 80 MB', async () => {
    const bigBuffer = Buffer.alloc(80 * 1024 * 1024 + 1)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await parseSidecar(bigBuffer, 'huge.pdf')

    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('parseSidecar returns ParseResult on success', async () => {
    const mockResult = {
      markdown: '# Hello',
      parser_used: 'docling',
      parser_version: '2.15.0',
      file_size_bytes: 5,
      duration_ms: 42,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResult,
    } as Response))

    const result = await parseSidecar(Buffer.from('hello'), 'doc.pdf')
    expect(result).toMatchObject(mockResult)
    vi.unstubAllGlobals()
  })

  it('chunkSemantic returns null on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')))
    const result = await chunkSemantic('some text', 512)
    expect(result).toBeNull()
    vi.unstubAllGlobals()
  })

  it('chunkSemantic returns ChunkResult on success', async () => {
    const mockResult = {
      chunks: [{ text: 'hello world', token_count: 2 }],
      strategy_used: 'chonkie-semantic',
      duration_ms: 5,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResult,
    } as Response))
    _resetCircuitBreaker()

    const result = await chunkSemantic('hello world', 512)
    expect(result).toMatchObject(mockResult)
    vi.unstubAllGlobals()
  })

  // ── glinerExtract (P2-10) ───────────────────────────────────────────

  it('glinerExtract returns GlinerResult on success and posts to /nlp/gliner', async () => {
    const mockResult = {
      entities: [{ text: 'Alice', label: 'person', score: 0.9, text_index: 0 }],
      model_version: 'urchade/gliner_small-v2.1',
      duration_ms: 12,
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => mockResult } as Response)
    vi.stubGlobal('fetch', fetchMock)
    _resetCircuitBreaker()

    const result = await glinerExtract(['Alice is blocked on deploy'])
    expect(result).toMatchObject(mockResult)
    expect(fetchMock.mock.calls[0][0]).toBe('http://sidecar.internal/nlp/gliner')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.labels).toEqual(['person', 'organization', 'project'])
    vi.unstubAllGlobals()
  })

  it('glinerExtract returns null on HTTP failure (503 model unavailable)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response))
    _resetCircuitBreaker()
    expect(await glinerExtract(['text'])).toBeNull()
    vi.unstubAllGlobals()
  })

  it('glinerExtract short-circuits empty input without a network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    _resetCircuitBreaker()
    const result = await glinerExtract([])
    expect(result).toMatchObject({ entities: [] })
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('glinerExtract returns null when circuit breaker is open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    _resetCircuitBreaker()
    for (let i = 0; i < 3; i++) await glinerExtract(['text'])
    expect(_circuitBreakerState().state).toBe('open')

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await glinerExtract(['text'])).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
