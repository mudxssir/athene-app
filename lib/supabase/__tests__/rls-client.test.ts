// ============================================================
// lib/supabase/__tests__/rls-client.test.ts
//
// Unit tests for getContextFromHeaders() (audit plan items 6B.1, 6C.3).
//
// getContextFromHeaders() is the gateway that converts middleware-injected
// HTTP headers into the RLSContext used by withRLS(). A bug here could
// allow:
//   - Clerk org IDs (format "org_xxx") to propagate as org_id, causing a
//     type mismatch with the uuid FK and potentially returning no rows or
//     leaking cross-org data if a Clerk ID accidentally matches a UUID.
//   - Unknown roles to pass through, bypassing role-based guards.
//   - Missing headers to silently degrade to an unsafe default.
//
// Coverage:
//   - Happy path: member, super_user, admin with all 5 headers present
//   - Rejects non-UUID org_id (Clerk format "org_xxxx")
//   - Returns null when org_id is missing
//   - Returns null when user_id is missing
//   - Returns null when user_role is missing
//   - Returns null for unknown role values
//   - Parses accessible_dept_ids JSON array correctly
//   - Falls back to empty array on malformed accessible_dept_ids JSON
//   - department_id defaults to '' when header absent
// ============================================================

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// rls-client.ts throws at module-evaluation time when Supabase env vars are
// absent. vi.mock factories run before imports (they're hoisted), so setting
// the env vars inside the factory ensures they're present when the module
// first initialises. The importActual pattern used in auth-unit.test.ts is
// the right approach here.
vi.mock('@/lib/supabase/rls-client', async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';
  const actual = await vi.importActual<typeof import('@/lib/supabase/rls-client')>(
    '@/lib/supabase/rls-client'
  );
  return actual;
});

vi.mock('@/lib/supabase/server', () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}));

import { getContextFromHeaders } from '@/lib/supabase/rls-client';

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const USER_UUID  = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const DEPT_UUID  = 'c3d4e5f6-a7b8-9012-cdef-123456789012';

function makeHeaders(overrides: Record<string, string | null> = {}): Headers {
  const base: Record<string, string> = {
    'x-current-org-id':          VALID_UUID,
    'x-current-user-id':         USER_UUID,
    'x-current-user-role':       'member',
    'x-current-user-dept-id':    DEPT_UUID,
    'x-current-accessible-depts': '[]',
  };

  const map = new Map<string, string>();
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v !== null) map.set(k, v);
  }

  return {
    get: (key: string) => map.get(key) ?? null,
  } as unknown as Headers;
}

describe('getContextFromHeaders', () => {

  it('returns a full context for a member with all headers present', () => {
    const ctx = getContextFromHeaders(makeHeaders());
    expect(ctx).not.toBeNull();
    expect(ctx!.org_id).toBe(VALID_UUID);
    expect(ctx!.user_id).toBe(USER_UUID);
    expect(ctx!.user_role).toBe('member');
    expect(ctx!.department_id).toBe(DEPT_UUID);
    expect(ctx!.accessible_dept_ids).toEqual([]);
  });

  it('returns a context for a super_user with accessible_dept_ids parsed correctly', () => {
    const deptIds = [DEPT_UUID, 'd4e5f6a7-b8c9-0123-defa-234567890123'];
    const ctx = getContextFromHeaders(makeHeaders({
      'x-current-user-role':       'super_user',
      'x-current-accessible-depts': JSON.stringify(deptIds),
    }));
    expect(ctx).not.toBeNull();
    expect(ctx!.user_role).toBe('super_user');
    expect(ctx!.accessible_dept_ids).toEqual(deptIds);
  });

  it('returns a context for an admin', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-user-role': 'admin' }));
    expect(ctx).not.toBeNull();
    expect(ctx!.user_role).toBe('admin');
  });

  // ── Security: Clerk org ID must be rejected ──────────────────────────────
  it('returns null when x-current-org-id is a Clerk org ID (not a UUID)', () => {
    // Clerk org IDs look like "org_2abc123xyz" — not a UUID
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-org-id': 'org_2aAbBcCdDeEfFgGhH' }));
    expect(ctx).toBeNull();
  });

  it('returns null when x-current-org-id is an empty string', () => {
    // null means header absent; empty string is present but invalid UUID
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-org-id': '' }));
    expect(ctx).toBeNull();
  });

  // ── Missing required headers ─────────────────────────────────────────────
  it('returns null when x-current-org-id header is missing', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-org-id': null }));
    expect(ctx).toBeNull();
  });

  it('returns null when x-current-user-id header is missing', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-user-id': null }));
    expect(ctx).toBeNull();
  });

  it('returns null when x-current-user-role header is missing', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-user-role': null }));
    expect(ctx).toBeNull();
  });

  // ── Unknown / spoofed role ───────────────────────────────────────────────
  it('returns null for an unrecognised role value', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-user-role': 'superadmin' }));
    expect(ctx).toBeNull();
  });

  it('returns null for an injected role escalation attempt', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-user-role': 'org:admin' }));
    expect(ctx).toBeNull();
  });

  // ── user_id: pass-through (no UUID validation) ───────────────────────────
  it('passes a non-UUID user_id through unchanged (middleware guarantees UUIDs)', () => {
    // getContextFromHeaders() intentionally does NOT validate user_id against
    // the UUID regex. The proxy middleware always injects access.internal_user_id
    // which is already a UUID, so an extra check here would be redundant overhead.
    // This test documents the intentional contract rather than a bug.
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-user-id': 'clerk_user_abc123' }));
    expect(ctx).not.toBeNull();
    expect(ctx!.user_id).toBe('clerk_user_abc123');
  });

  // ── Optional headers ─────────────────────────────────────────────────────
  it('defaults department_id to empty string when header is absent', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-user-dept-id': null }));
    expect(ctx).not.toBeNull();
    expect(ctx!.department_id).toBe('');
  });

  it('defaults accessible_dept_ids to [] when header is absent', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-accessible-depts': null }));
    expect(ctx).not.toBeNull();
    expect(ctx!.accessible_dept_ids).toEqual([]);
  });

  it('falls back to [] when accessible_dept_ids header is malformed JSON', () => {
    const ctx = getContextFromHeaders(makeHeaders({ 'x-current-accessible-depts': '{broken json' }));
    expect(ctx).not.toBeNull();
    expect(ctx!.accessible_dept_ids).toEqual([]);
  });
});
