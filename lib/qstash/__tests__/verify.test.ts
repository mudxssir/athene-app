// ============================================================
// lib/qstash/__tests__/verify.test.ts
//
// Unit tests for checkIdempotency() (audit plan items 5B.2, 2C.3).
//
// Coverage:
//   - First delivery: returns true (new message ID → SET NX succeeds)
//   - Duplicate delivery: returns false (key already exists)
//   - Missing message ID: returns true (no ID → can't dedup, allow)
//   - Redis down (fail-open): returns true, logs error
//   - TTL is exactly 24 hours (86400 seconds)
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// vi.mock factories are hoisted to the top of the file and run before any
// `const` declarations. Use vi.hoisted() to lift the controllable mocks.
const { redisMock, loggerMock } = vi.hoisted(() => {
  // Only `set` is called by checkIdempotency(); no other redis methods needed.
  const redisMock = { set: vi.fn() };
  const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { redisMock, loggerMock };
});

vi.mock('@/lib/logger', () => ({ logger: loggerMock }));

vi.mock('@/lib/redis/client', () => ({
  redis: redisMock,
  incrWithExpire: vi.fn().mockResolvedValue(1),
  rateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99 }),
  cached: vi.fn(),
}));

// Prevent the module-level Receiver instantiation from failing on missing env vars
vi.mock('@upstash/qstash', () => ({
  Receiver: vi.fn().mockImplementation(() => ({
    verify: vi.fn().mockResolvedValue(true),
  })),
}));

import { checkIdempotency } from '@/lib/qstash/verify';

// Helper: build a minimal Request with controlled headers
function makeRequest(messageId?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (messageId) headers['upstash-message-id'] = messageId;
  return new Request('http://localhost/api/worker/test', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

describe('checkIdempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true on first delivery (SET NX returns OK)', async () => {
    redisMock.set.mockResolvedValue('OK');
    const result = await checkIdempotency(makeRequest('msg-001'));
    expect(result).toBe(true);
    expect(redisMock.set).toHaveBeenCalledWith(
      'qstash_job:msg-001',
      '1',
      { nx: true, ex: 86400 },
    );
  });

  it('returns false on duplicate delivery (SET NX returns null — key already exists)', async () => {
    redisMock.set.mockResolvedValue(null);
    const result = await checkIdempotency(makeRequest('msg-001'));
    expect(result).toBe(false);
  });

  it('returns true when upstash-message-id header is absent (cannot dedup → allow)', async () => {
    const result = await checkIdempotency(makeRequest(/* no id */));
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('returns true (fail-open) when Redis throws, and logs an error', async () => {
    redisMock.set.mockRejectedValue(new Error('connection refused'));
    const result = await checkIdempotency(makeRequest('msg-002'));
    expect(result).toBe(true);
    expect(loggerMock.error as Mock).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'connection refused' }),
      expect.any(String),
    );
  });

  it('uses a 24-hour Redis TTL (86400 seconds)', async () => {
    redisMock.set.mockResolvedValue('OK');
    await checkIdempotency(makeRequest('msg-ttl'));
    expect(redisMock.set).toHaveBeenCalledWith(
      expect.any(String),
      '1',
      expect.objectContaining({ ex: 86400 }),
    );
  });

  it('returns false on a second call when the mock simulates a key already set (OK then null)', async () => {
    // The mock returns OK for the first delivery, then null to simulate the key
    // already existing on a second delivery. This exercises the true/false
    // branching in checkIdempotency, not real Redis NX semantics.
    redisMock.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    expect(await checkIdempotency(makeRequest('msg-003'))).toBe(true);
    expect(await checkIdempotency(makeRequest('msg-003'))).toBe(false);
  });
});
