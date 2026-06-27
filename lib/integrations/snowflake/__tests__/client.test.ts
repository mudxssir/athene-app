import { describe, it, expect, vi, beforeEach } from 'vitest'
import { snowflakeFetch } from '../client'
import * as nango from '@/lib/nango/client'

vi.mock('@/lib/integrations/base', async () => {
  const actual = await vi.importActual('@/lib/integrations/base')
  return {
    ...actual,
    getProviderToken: vi.fn().mockResolvedValue('test-token'),
  }
})

vi.mock('@/lib/nango/client', () => ({
  getToken: vi.fn(),
  getConnection: vi.fn(),
}))

describe('snowflake client', () => {
  const mockFetch = vi.fn()
  global.fetch = mockFetch

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(nango.getConnection).mockResolvedValue({
      metadata: { account_identifier: 'abc1234' }
    } as any)
  })

  it('should include correct headers including X-Snowflake-Authorization-Token-Type', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ results: [] })
    })

    await snowflakeFetch('conn-123', 'org-123', 'SELECT 1')

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('abc1234.snowflakecomputing.com'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'X-Snowflake-Authorization-Token-Type': 'OAUTH',
        }),
        body: JSON.stringify({ statement: 'SELECT 1', timeout: 30 })
      })
    )
  })

  it('should retry on 429', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 429,
      headers: new Headers({ 'Retry-After': '0' })
    })
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true })
    })

    vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => fn())

    const result = await snowflakeFetch('conn-123', 'org-123', 'SELECT 1')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(result.success).toBe(true)
  })
})
