// ============================================================
// lib/tools/__tests__/vector-search-decrypt.test.ts
//
// P7-1 live-path encryption regression guard. The vector_search RPC COALESCEs the
// stored (possibly encrypted) metadata->>'chunk_text' into its chunk_text /
// content_preview output columns in SQL — so when CHUNK_TEXT_ENCRYPTION is on the
// retrieval path must decrypt those app-side BEFORE any LLM/citation consumer.
// This guards against the original bug where the decrypt lived on a dead module.
// ============================================================

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const { embedMock, mockRpc } = vi.hoisted(() => ({ embedMock: vi.fn(), mockRpc: vi.fn() }));

vi.mock("../../ai/embedder", () => ({ embed: embedMock }));
vi.mock("../../ai/embedding-factory", () => ({ fetchOrgPinnedModel: vi.fn(async () => "jina-embeddings-v3") }));
vi.mock("../../supabase/rls-client", () => ({ withRLS: vi.fn((_c: any, fn: (s: any) => any) => fn({ rpc: mockRpc })) }));
vi.mock("../../telemetry/spans", () => ({
  withVectorSearchSpan: vi.fn((_q: string, _o: string, _k: number, fn: (s: any) => any) => fn({ setAttribute: vi.fn() })),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
// Encryption ON for this file.
vi.mock("@/lib/config/feature-flags", () => ({ PIPELINE_SHAPE_ROUTING: false, CHUNK_TEXT_ENCRYPTION: true }));

beforeAll(() => { process.env.KMS_KEY = "test-master-key-vec-decrypt"; });

import { vectorSearch } from "../vector-search";
import { encryptChunkText } from "@/lib/indexing/chunk-crypto";

const ORG = "dddddddd-dddd-dddd-dddd-dddddddddddd";

beforeEach(() => {
  vi.clearAllMocks();
  embedMock.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe("vectorSearch — decrypt at the live retrieval boundary (P7-1 fix)", () => {
  it("decrypts encrypted chunk_text / content_preview from the RPC output", async () => {
    const secret = "Q3 revenue was $4.2M, owned by Dana.";
    const envelope = encryptChunkText(secret, ORG);
    expect(envelope.startsWith("encv1:")).toBe(true); // sanity: it IS encrypted

    mockRpc.mockResolvedValue({
      data: [{ id: "r1", document_id: "d1", chunk_text: envelope, content_preview: envelope, similarity: 0.9 }],
      error: null,
    });

    const rows = await vectorSearch({ orgId: ORG, userId: "u1", user_role: "member", query: "revenue", topK: 5 });
    expect(rows[0].chunk_text).toBe(secret);       // decrypted plaintext, not ciphertext
    expect(rows[0].content_preview).toBe(secret);
    expect(rows[0].chunk_text).not.toContain("encv1:");
  });

  it("leaves plaintext rows untouched (mixed-row migration)", async () => {
    mockRpc.mockResolvedValue({
      data: [{ id: "r2", document_id: "d2", chunk_text: "already plaintext", content_preview: "already plaintext", similarity: 0.8 }],
      error: null,
    });
    const rows = await vectorSearch({ orgId: ORG, userId: "u1", user_role: "member", query: "x", topK: 5 });
    expect(rows[0].chunk_text).toBe("already plaintext");
  });

  it("yields empty string (not ciphertext) when decrypt fails with the wrong org key", async () => {
    const envelope = encryptChunkText("secret", "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"); // other org
    mockRpc.mockResolvedValue({
      data: [{ id: "r3", document_id: "d3", chunk_text: envelope, content_preview: envelope, similarity: 0.7 }],
      error: null,
    });
    const rows = await vectorSearch({ orgId: ORG, userId: "u1", user_role: "member", query: "x", topK: 5 });
    expect(rows[0].chunk_text).toBe("");           // fail-closed, never leak ciphertext
    expect(rows[0].chunk_text).not.toContain("encv1:");
  });
});
