// ============================================================
// app/api/nango/webhook/__tests__/webhook-empty-secret.test.ts
//
// Fail-closed security test for the Nango webhook route (8A.6).
//
// Companion to webhook.test.ts. That file cannot test the empty-secret path
// because the route captures `const NANGO_SECRET = process.env.NANGO_SECRET_KEY
// ?? ""` into a module-level const at import time, and that file's vi.hoisted()
// already sets a real secret. A SEPARATE file with its own vi.hoisted() block
// (setting NANGO_SECRET_KEY="") gets a fresh module evaluation, so the route's
// const is captured as "" — exactly the misconfiguration we want to prove is
// safe.
//
// Expected behavior: with no server secret, verifyNangoSignature returns false
// for EVERY request (even a syntactically valid one), so the route rejects with
// 401 and never reaches event dispatch. This is the fail-closed guarantee — a
// missing/empty NANGO_SECRET_KEY must never silently accept unsigned traffic.
// ============================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";

// ─── Set env var BEFORE any module is imported ───────────────────────────────
// Empty string is the misconfiguration under test. It must run before `../route`
// is imported so the route's module-level NANGO_SECRET const captures "".

vi.hoisted(() => {
  process.env.NANGO_SECRET_KEY    = "";
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
  dispatchThrottled: vi.fn(() => Promise.resolve({ dispatched: true, msgId: "msg-test-123" })),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Module under test (imported AFTER hoisted env and mocks) ────────────────

import { POST } from "../route";
import { dispatchThrottled } from "@/lib/qstash/client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const APP_URL = "https://test.athene.ai";
const SAMPLE_BODY = JSON.stringify({ type: "sync.completed", providerConfigKey: "github", connectionId: "nango-conn-abc" });

function makeRequest(body: string, headers: Record<string, string>): Request {
  return new Request(`${APP_URL}/api/nango/webhook`, { method: "POST", body, headers });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Nango webhook fail-closed when NANGO_SECRET_KEY is empty (8A.6)", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejects a request that carries a syntactically valid HMAC signature → 401", async () => {
    // An attacker (or a real Nango instance) could send a well-formed HMAC, but
    // with NO server secret the route can verify nothing → must reject.
    const sig = createHmac("sha256", "any-secret-the-client-chose").update(SAMPLE_BODY).digest("hex");
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type":      "application/json",
      "x-nango-signature": sig,
    });

    const response = await POST(req as any);

    expect(response.status).toBe(401);
    // Fail-closed: rejected before any event dispatch.
    expect(vi.mocked(dispatchThrottled)).not.toHaveBeenCalled();
  });

  it("rejects a request with no signature header → 401", async () => {
    const req = makeRequest(SAMPLE_BODY, { "Content-Type": "application/json" });

    const response = await POST(req as any);

    expect(response.status).toBe(401);
    expect(vi.mocked(dispatchThrottled)).not.toHaveBeenCalled();
  });

  it("rejects even an empty-string signature against an empty secret → 401 (no all-empty bypass)", async () => {
    // Guards against a degenerate `"" === ""` acceptance — the !NANGO_SECRET
    // guard fires first, so an empty signature is rejected too.
    const req = makeRequest(SAMPLE_BODY, {
      "Content-Type":      "application/json",
      "x-nango-signature": "",
    });

    const response = await POST(req as any);

    expect(response.status).toBe(401);
    expect(vi.mocked(dispatchThrottled)).not.toHaveBeenCalled();
  });
});
