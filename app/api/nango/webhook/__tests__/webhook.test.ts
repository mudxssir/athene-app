// ============================================================
// app/api/nango/webhook/__tests__/webhook.test.ts
//
// Security boundary tests for the Nango webhook route (8A.6).
//
// Coverage:
//   - Valid HMAC signature → 200 (request accepted)
//   - Invalid HMAC signature → 401 (request rejected)
//   - Missing signature header → 401
//   - Signature signed with wrong key → 401
//   - timingSafeEqual: mismatched-length hex → 401
//   - sha256= prefixed signatures (standard webhook format) accepted
//
// Note on NANGO_SECRET_KEY: the route captures the env var into a
// module-level const at import time. We set it in vi.hoisted() so
// the correct value is present when the module is first evaluated.
// ============================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// ─── Set env var BEFORE any module is imported ───────────────────────────────

const TEST_SECRET = "nango-test-secret-key";

vi.hoisted(() => {
  // Must run before `../route` is imported, because the route captures
  // NANGO_SECRET_KEY into a module-level const on first evaluation.
  process.env.NANGO_SECRET_KEY   = "nango-test-secret-key";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.athene.ai";
});

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select:      vi.fn().mockReturnThis(),
      eq:          vi.fn().mockReturnThis(),
      delete:      vi.fn().mockReturnThis(),
      update:      vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    })),
  },
}));

vi.mock("@/lib/qstash/client", () => ({
  // Must return { dispatched, msgId } — the route destructures this immediately
  dispatchThrottled: vi.fn(() => Promise.resolve({ dispatched: true, msgId: "msg-test-123" })),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Module under test (imported AFTER hoisted env and mocks) ────────────────

import { POST } from "../route";
import { supabaseAdmin } from "@/lib/supabase/server";
import { dispatchThrottled } from "@/lib/qstash/client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const APP_URL    = "https://test.athene.ai";
const SAMPLE_BODY = JSON.stringify({ type: "sync.completed", providerConfigKey: "github" });

/** Generate a valid HMAC-SHA256 signature for the given body and secret. */
function makeSignature(body: string, secret = TEST_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Build a NextRequest-compatible Request object. */
function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request(`${APP_URL}/api/nango/webhook`, {
    method: "POST",
    body,
    headers,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Nango webhook HMAC verification (8A.6)", () => {
  afterEach(() => vi.clearAllMocks());

  it("accepts a request with a valid HMAC-SHA256 signature → 200", async () => {
    const sig = makeSignature(SAMPLE_BODY);
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type":      "application/json",
      "x-nango-signature": sig,
    });

    const response = await POST(req as any);

    expect(response.status).toBe(200);
  });

  it("rejects a request with an invalid signature → 401", async () => {
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type":      "application/json",
      "x-nango-signature": "deadbeef",
    });

    const response = await POST(req as any);

    expect(response.status).toBe(401);
  });

  it("rejects when signature is for a different body (replay/tamper) → 401", async () => {
    const sig = makeSignature('{"type":"tampered"}');
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type":      "application/json",
      "x-nango-signature": sig,
    });

    const response = await POST(req as any);

    expect(response.status).toBe(401);
  });

  it("rejects a request with no signature header → 401", async () => {
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type": "application/json",
      // no x-nango-signature
    });

    const response = await POST(req as any);

    expect(response.status).toBe(401);
  });

  it("rejects a signature generated with the wrong secret key → 401", async () => {
    const sig = makeSignature(SAMPLE_BODY, "wrong-secret-entirely");
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type":      "application/json",
      "x-nango-signature": sig,
    });

    const response = await POST(req as any);

    expect(response.status).toBe(401);
  });

  it("accepts sha256= prefixed signatures (standard webhook format) → 200", async () => {
    const sig = `sha256=${makeSignature(SAMPLE_BODY)}`;
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type":      "application/json",
      "x-nango-signature": sig,
    });

    const response = await POST(req as any);

    expect(response.status).toBe(200);
  });

  it("rejects a signature of odd hex length (timingSafeEqual length check) → 401", async () => {
    // An odd-length hex string cannot be decoded to a Buffer — the route
    // must handle this gracefully and return 401 rather than throwing.
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type":      "application/json",
      "x-nango-signature": "abc",           // odd length, invalid hex
    });

    const response = await POST(req as any);

    expect(response.status).toBe(401);
  });

  it("dispatches a nango-fetch job for sync.completed with a known connection → dispatchThrottled called", async () => {
    // Override the Supabase mock for this test only: return a connection row so the
    // handler doesn't short-circuit before reaching dispatchThrottled.
    vi.mocked(supabaseAdmin.from).mockReturnValueOnce({
      select:      vi.fn().mockReturnThis(),
      eq:          vi.fn().mockReturnThis(),
      delete:      vi.fn().mockReturnThis(),
      update:      vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(() => Promise.resolve({
        data: {
          id:            "conn-uuid-123",
          org_id:        "org-uuid-456",
          source_type:   "github",
          provider:      "github",
          department_id: null,
        },
        error: null,
      })),
    } as any);

    const body = JSON.stringify({
      type:              "sync.completed",
      providerConfigKey: "github",
      connectionId:      "nango-conn-abc",
    });
    const sig = makeSignature(body);
    const req = makeRequest(body, {
      "Content-Type":      "application/json",
      "x-nango-signature": sig,
    });

    const response = await POST(req as any);

    expect(response.status).toBe(200);
    expect(vi.mocked(dispatchThrottled)).toHaveBeenCalledOnce();
  });

  // The empty-secret fail-closed path (NANGO_SECRET_KEY = "") is covered in a
  // separate file — webhook-empty-secret.test.ts — because the route captures
  // `const NANGO_SECRET = process.env.NANGO_SECRET_KEY ?? ""` at module-load time
  // and this file's vi.hoisted() already sets a real secret. A separate file gets
  // its own fresh module evaluation with an empty secret.
});
