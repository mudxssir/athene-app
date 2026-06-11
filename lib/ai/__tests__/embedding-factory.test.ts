// ============================================================
// lib/ai/__tests__/embedding-factory.test.ts
//
// Unit tests for the embedding factory (8A.4).
//
// Coverage:
//   - BYOK path skipped when KMS_KEY is not set (logs error, falls back)
//   - BYOK resolved when Supabase RPC returns an OpenAI key
//   - System provider (Jina) used when BYOK unavailable
//   - assertDims throws on wrong-dimension vector (dimension mismatch guard)
//   - embedBatch returns one vector per input text
//   - Empty input handled without API call
//   - Local model used as final fallback when all API providers fail
//
// Provider mock strategy:
//   • System provider → JINA_API_KEY (uses raw fetch, easy to mock)
//   • BYOK (OpenAI)   → mock the openai SDK constructor
//   • Local model     → mock @xenova/transformers pipeline
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock state ───────────────────────────────────────────────────────

const { rpcMock, fetchMock, openaiCreateMock, localPipelineMock } = vi.hoisted(() => ({
  rpcMock:            vi.fn(),
  fetchMock:          vi.fn(),
  openaiCreateMock:   vi.fn(),
  localPipelineMock:  vi.fn(),
}));

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => ({
  supabaseAdmin: { rpc: rpcMock },
}));

vi.mock("@/lib/auth/kms", () => ({
  getMasterKey: vi.fn(() => "test-master-key"),
  deriveOrgKey:  vi.fn(() => "derived-org-key"),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock the OpenAI SDK (used by BYOK path and Together/Nomic compat)
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: openaiCreateMock },
  })),
}));

// Replace global fetch (used by Jina provider)
vi.stubGlobal("fetch", fetchMock);

// Stub Xenova/Transformers (used by local fallback)
vi.mock("@xenova/transformers", () => ({
  pipeline: vi.fn(() => Promise.resolve(localPipelineMock)),
  env: { allowLocalModels: true, allowRemoteModels: false },
}));

// ─── Module under test ───────────────────────────────────────────────────────

import { embed, embedBatch, EMBEDDING_DIMS } from "@/lib/ai/embedding-factory";
import { getMasterKey } from "@/lib/auth/kms";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A valid EMBEDDING_DIMS-dim zero vector. */
const ZERO_VEC = Array(EMBEDDING_DIMS).fill(0);

/** Mock Jina API to return the given vectors. */
function mockJinaResponse(vecs: number[][]): void {
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        data: vecs.map((embedding, index) => ({ embedding, index, object: "embedding" })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  );
}

/** Make the BYOK RPC return a Jina key and mock the fetch response.
 *  Jina uses raw fetch (not the OpenAI SDK), so it's straightforward to mock.
 *
 *  RPC contract: get_decrypted_llm_key returns rows shaped as
 *    { provider: string, plaintext: string }
 *  where `plaintext` is the decrypted API key.  If the DB function schema
 *  ever changes this shape, update the mock here to match. */
function mockByokJina(vecs: number[][]): void {
  rpcMock.mockResolvedValue({
    data: [{ provider: "jina", plaintext: "jina-byok-test-key" }],
    error: null,
  });
  mockJinaResponse(vecs);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("BYOK resolution", () => {
  const ENV_KEYS = ["JINA_API_KEY", "TOGETHER_API_KEY", "NOMIC_API_KEY", "GOOGLE_API_KEY"];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    // Save and clear all system provider keys so only BYOK is active
    ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    });
  });

  it("skips BYOK and uses local fallback when KMS_KEY is not set — logs the error (8A.4)", async () => {
    vi.mocked(getMasterKey).mockImplementation(() => {
      throw new Error("KMS_KEY is not set");
    });
    // Local model returns a valid vector
    localPipelineMock.mockResolvedValue({ data: new Float32Array(ZERO_VEC) });

    const result = await embed("hello world");

    // BYOK RPC was NOT called (KMS_KEY failure short-circuits before Supabase)
    expect(rpcMock).not.toHaveBeenCalled();
    expect(result).toHaveLength(EMBEDDING_DIMS);
  });

  it("resolves BYOK via Supabase RPC and uses the org's Jina key (8A.4)", async () => {
    vi.mocked(getMasterKey).mockReturnValue("test-master-key");
    mockByokJina([ZERO_VEC]);

    const result = await embed("byok text", "org-uuid-123");

    // RPC must have been called to fetch the org key
    expect(rpcMock).toHaveBeenCalledWith("get_decrypted_llm_key", expect.any(Object));
    // Jina fetch must have been called (BYOK embedding request)
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toHaveLength(EMBEDDING_DIMS);
  });

  it("falls back to local model when RPC returns empty key rows (no BYOK configured)", async () => {
    vi.mocked(getMasterKey).mockReturnValue("test-master-key");
    rpcMock.mockResolvedValue({ data: [], error: null });
    localPipelineMock.mockResolvedValue({ data: new Float32Array(ZERO_VEC) });

    const result = await embed("no byok", "org-uuid-456");

    expect(result).toHaveLength(EMBEDDING_DIMS);
    // BYOK RPC was attempted but returned nothing
    expect(rpcMock).toHaveBeenCalledWith("get_decrypted_llm_key", expect.any(Object));
    // No OpenAI BYOK key → local model used
    expect(openaiCreateMock).not.toHaveBeenCalled();
  });

  it("falls back to local model when RPC returns a DB error (error path)", async () => {
    vi.mocked(getMasterKey).mockReturnValue("test-master-key");
    // Simulate a real Supabase error response (data is null, error is set)
    rpcMock.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    localPipelineMock.mockResolvedValue({ data: new Float32Array(ZERO_VEC) });

    const result = await embed("rpc error text", "org-uuid-rpc-error");

    // RPC was attempted but errored — should not throw, should fall back
    expect(rpcMock).toHaveBeenCalled();
    expect(result).toHaveLength(EMBEDDING_DIMS);
  });
});

describe("System provider (Jina via fetch)", () => {
  const savedJina = process.env.JINA_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JINA_API_KEY = "jina-test-key";
    // No BYOK: getMasterKey throws
    vi.mocked(getMasterKey).mockImplementation(() => {
      throw new Error("KMS_KEY is not set");
    });
    rpcMock.mockResolvedValue({ data: [], error: null });
  });

  afterEach(() => {
    if (savedJina !== undefined) process.env.JINA_API_KEY = savedJina;
    else delete process.env.JINA_API_KEY;
  });

  it("uses the Jina system provider when JINA_API_KEY is set", async () => {
    mockJinaResponse([ZERO_VEC]);

    const result = await embed("test text");

    expect(fetchMock).toHaveBeenCalled();
    expect(result).toHaveLength(EMBEDDING_DIMS);
  });
});

describe("Dimension assertion (assertDims)", () => {
  const savedJina = process.env.JINA_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JINA_API_KEY = "jina-test-key";
    vi.mocked(getMasterKey).mockImplementation(() => {
      throw new Error("KMS_KEY is not set");
    });
    rpcMock.mockResolvedValue({ data: [], error: null });
  });

  afterEach(() => {
    if (savedJina !== undefined) process.env.JINA_API_KEY = savedJina;
    else delete process.env.JINA_API_KEY;
  });

  it("throws a dimension-mismatch error when the provider returns the wrong vector size (8A.4)", async () => {
    // Jina returns 1536-dim vectors — wrong for our 768-dim schema
    const wrongDimVec = Array(1536).fill(0.1);
    mockJinaResponse([wrongDimVec]);

    // All retries also return wrong-dim → dimension mismatch bubbles out
    await expect(embed("dimension check")).rejects.toThrow(/dimension mismatch/i);
  });
});

describe("embedBatch", () => {
  const savedJina = process.env.JINA_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JINA_API_KEY = "jina-test-key";
    vi.mocked(getMasterKey).mockImplementation(() => {
      throw new Error("KMS_KEY is not set");
    });
    rpcMock.mockResolvedValue({ data: [], error: null });
  });

  afterEach(() => {
    if (savedJina !== undefined) process.env.JINA_API_KEY = savedJina;
    else delete process.env.JINA_API_KEY;
  });

  it("returns one vector per input text (8A.4)", async () => {
    const texts = ["hello", "world", "foo"];
    mockJinaResponse(texts.map(() => ZERO_VEC));

    const results = await embedBatch(texts);

    expect(results).toHaveLength(texts.length);
    results.forEach((v) => expect(v).toHaveLength(EMBEDDING_DIMS));
  });

  it("returns empty array without calling the API for empty input", async () => {
    const results = await embedBatch([]);

    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Local model fallback", () => {
  const ENV_KEYS = ["JINA_API_KEY", "TOGETHER_API_KEY", "NOMIC_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
    vi.mocked(getMasterKey).mockImplementation(() => {
      throw new Error("KMS_KEY is not set");
    });
    rpcMock.mockResolvedValue({ data: [], error: null });
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    });
  });

  it("falls back to local Xenova model when all HTTP providers are unavailable (8A.4)", async () => {
    // Local pipeline: return valid 768-dim vector
    localPipelineMock.mockResolvedValue({ data: new Float32Array(ZERO_VEC) });

    const result = await embed("local fallback test");

    expect(result).toHaveLength(EMBEDDING_DIMS);
  });
});

// ─── P0-2 (audit D5): Jina task type follows the embedding hint ──────────────

describe("Jina task type per hint (P0-2)", () => {
  const ENV_KEYS = ["JINA_API_KEY", "TOGETHER_API_KEY", "NOMIC_API_KEY", "GOOGLE_API_KEY"];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; });
    process.env.JINA_API_KEY = "jina-system-test-key";
    rpcMock.mockResolvedValue({ data: [], error: null }); // no BYOK
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
      else delete process.env[k];
    });
  });

  function lastJinaBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.at(-1);
    return JSON.parse((call?.[1] as RequestInit).body as string);
  }

  it("sends retrieval.query when hint is 'query'", async () => {
    mockJinaResponse([ZERO_VEC]);
    await embed("who owns the billing service", undefined, "query");
    expect(lastJinaBody().task).toBe("retrieval.query");
  });

  it("sends retrieval.passage by default (document/index path)", async () => {
    mockJinaResponse([ZERO_VEC]);
    await embed("indexed chunk text", undefined, "document");
    expect(lastJinaBody().task).toBe("retrieval.passage");
  });
});
