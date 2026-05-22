// ============================================================
// lib/auth/__tests__/auth-unit.test.ts
//
// Unit tests for auth utility functions (8A.1 audit item).
// Tests: mapRole, getMasterKey, deriveOrgKey, getContextFromHeaders
//
// These functions sit at the root of every request's security
// chain — a bug here has org-wide blast radius.
// ============================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mapRole } from '@/lib/auth/clerk';
import { getMasterKey, deriveOrgKey } from '@/lib/auth/kms';

// rls-client.ts has a module-level throw when Supabase env vars are missing.
// Set them before the module is evaluated by placing process.env assignments in
// vi.mock factory (which is hoisted to run before all imports).
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('@/lib/supabase/rls-client', async () => {
  // Provide stub env vars so the module-level createClient call doesn't throw
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const actual = await vi.importActual<typeof import('@/lib/supabase/rls-client')>('@/lib/supabase/rls-client');
  return actual;
});

// Import after mocks are set up
import { getContextFromHeaders } from '@/lib/supabase/rls-client';

// ─────────────────────────────────────────────────────────────────────────────
// mapRole
// ─────────────────────────────────────────────────────────────────────────────

describe('mapRole', () => {
  it('maps org:admin → admin', () => {
    expect(mapRole('org:admin')).toBe('admin');
  });

  it('maps org:member → member', () => {
    expect(mapRole('org:member')).toBe('member');
  });

  it('maps org:bi_analyst → super_user', () => {
    expect(mapRole('org:bi_analyst')).toBe('super_user');
  });

  it('returns null for unknown role string (prevents privilege escalation)', () => {
    expect(mapRole('org:superadmin')).toBeNull();
    expect(mapRole('admin')).toBeNull();
    expect(mapRole('')).toBeNull();
    expect(mapRole('UNKNOWN')).toBeNull();
  });

  it('returns null when called with no argument (undefined)', () => {
    expect(mapRole(undefined)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMasterKey
// ─────────────────────────────────────────────────────────────────────────────

describe('getMasterKey', () => {
  const original = process.env.KMS_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.KMS_KEY;
    } else {
      process.env.KMS_KEY = original;
    }
  });

  it('returns the KMS_KEY env var when set', () => {
    process.env.KMS_KEY = 'test-master-key-abc123';
    expect(getMasterKey()).toBe('test-master-key-abc123');
  });

  it('throws when KMS_KEY is not set (no silent fallback to empty key)', () => {
    delete process.env.KMS_KEY;
    expect(() => getMasterKey()).toThrowError(/KMS_KEY/);
  });

  it('throws when KMS_KEY is an empty string', () => {
    process.env.KMS_KEY = '';
    expect(() => getMasterKey()).toThrowError(/KMS_KEY/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveOrgKey
// ─────────────────────────────────────────────────────────────────────────────

describe('deriveOrgKey', () => {
  const masterKey = 'test-master-key';
  const orgId = '550e8400-e29b-41d4-a716-446655440000';

  it('produces a non-empty hex string', () => {
    const derived = deriveOrgKey(masterKey, orgId);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    expect(deriveOrgKey(masterKey, orgId)).toBe(deriveOrgKey(masterKey, orgId));
  });

  it('produces different keys for different orgs', () => {
    const orgId2 = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
    expect(deriveOrgKey(masterKey, orgId)).not.toBe(deriveOrgKey(masterKey, orgId2));
  });

  it('produces different keys for different master keys', () => {
    expect(deriveOrgKey('key-A', orgId)).not.toBe(deriveOrgKey('key-B', orgId));
  });

  it('output length is exactly 64 hex chars (256-bit key)', () => {
    expect(deriveOrgKey(masterKey, orgId)).toHaveLength(64);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getContextFromHeaders
// ─────────────────────────────────────────────────────────────────────────────

function makeHeaders(overrides: Record<string, string> = {}): Headers {
  const defaults: Record<string, string> = {
    'x-current-org-id': '550e8400-e29b-41d4-a716-446655440000',
    'x-current-user-id': 'user-internal-uuid',
    'x-current-user-role': 'member',
    'x-current-user-dept-id': '',
    'x-current-accessible-depts': '[]',
    ...overrides,
  };
  return new Headers(defaults);
}

describe('getContextFromHeaders', () => {
  it('returns a valid context for correct headers', () => {
    const ctx = getContextFromHeaders(makeHeaders());
    expect(ctx).not.toBeNull();
    expect(ctx?.org_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(ctx?.user_id).toBe('user-internal-uuid');
    expect(ctx?.user_role).toBe('member');
  });

  it('returns null when org_id header is missing', () => {
    const h = makeHeaders();
    h.delete('x-current-org-id');
    expect(getContextFromHeaders(h)).toBeNull();
  });

  it('returns null when user_id header is missing', () => {
    const h = makeHeaders();
    h.delete('x-current-user-id');
    expect(getContextFromHeaders(h)).toBeNull();
  });

  it('returns null when user_role header is missing', () => {
    const h = makeHeaders();
    h.delete('x-current-user-role');
    expect(getContextFromHeaders(h)).toBeNull();
  });

  it('rejects Clerk org IDs (non-UUID format) to prevent middleware misconfiguration', () => {
    // Clerk org IDs look like "org_2abc..." — middleware must convert them
    const h = makeHeaders({ 'x-current-org-id': 'org_2abc123def456ghi' });
    expect(getContextFromHeaders(h)).toBeNull();
  });

  it('rejects unknown role values (hardening against header injection)', () => {
    const h = makeHeaders({ 'x-current-user-role': 'superadmin' });
    expect(getContextFromHeaders(h)).toBeNull();
  });

  it('accepts all three valid roles', () => {
    for (const role of ['member', 'super_user', 'admin']) {
      const ctx = getContextFromHeaders(makeHeaders({ 'x-current-user-role': role }));
      expect(ctx?.user_role).toBe(role);
    }
  });

  it('parses accessible_dept_ids from JSON header', () => {
    const depts = ['dept-uuid-1', 'dept-uuid-2'];
    const h = makeHeaders({ 'x-current-accessible-depts': JSON.stringify(depts) });
    const ctx = getContextFromHeaders(h);
    expect(ctx?.accessible_dept_ids).toEqual(depts);
  });

  it('returns empty array for malformed accessible_dept_ids JSON', () => {
    const h = makeHeaders({ 'x-current-accessible-depts': 'not-json' });
    const ctx = getContextFromHeaders(h);
    expect(ctx?.accessible_dept_ids).toEqual([]);
  });
});
