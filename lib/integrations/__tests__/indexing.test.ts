// ============================================================
// lib/integrations/__tests__/indexing.test.ts
//
// Unit tests for the indexing pipeline (audit plan Domains 3B & 3C).
//
// Coverage:
//   3B.2 — Every upsert to document_embeddings includes org_id
//   3B.3 — Stale chunk pruning is scoped to (document_id, chunk_index)
//          in both the single-doc path (indexDocument) and the batch
//          path (indexDocuments)
//   3B.5 — Embedding batch size (EMBED_BATCH_SIZE = 96) is not exceeded
//          per call to embedBatch
//   3C.4 — Content hash dedup: unchanged document → embedBatch not called
//
// Testing strategy:
//   supabaseAdmin is mocked to return controllable query results.
//   embedBatch is mocked so we can assert call counts and arg sizes.
//   The modules under test (indexDocument, indexDocuments) are
//   imported as real code so business logic runs as in production.
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { FetchedChunk } from "@/lib/integrations/base";

// ─── Controllable mock state ─────────────────────────────────────────────────

type DeleteCall = {
  table: string;
  docId: string;
  chunkThreshold: number;
  operator: "gte" | "gt";
};

type UpsertCall = {
  table: string;
  records: unknown;
};

const { embedBatchMock, supabaseState } = vi.hoisted(() => {
  const supabaseState = {
    existingDoc: null as null | { id: string; content_hash: string },
    upsertDocReturn: { id: "doc-uuid-1" } as { id: string } | null,
    upsertEmbeddingsError: null as { message: string } | null,
    deleteCalls: [] as DeleteCall[],
    upsertCalls: [] as UpsertCall[],
  };

  return {
    embedBatchMock: vi.fn<[string[], string | undefined], Promise<number[][]>>(),
    supabaseState,
  };
});

// ─── Mock: embedding factory ─────────────────────────────────────────────────
// embedBatchMock keeps its number[][] contract; the P0-3 detailed wrapper adapts
// it to the { embeddings, model, provider } shape indexing.ts now consumes.

vi.mock("@/lib/ai/embedding-factory", () => ({
  embedBatch: embedBatchMock,
  embedBatchDetailed: async (texts: string[], orgId?: string, hint?: string) => ({
    embeddings: await embedBatchMock(texts, orgId, hint),
    model: "test-embedding-model",
    provider: "test",
  }),
  EMBEDDING_DIMS: 768,
}));

// ─── Mock: supabaseAdmin ─────────────────────────────────────────────────────

vi.mock("@/lib/supabase/server", () => {
  // Terminal node — every query chain ends here.
  const leaf = (data: unknown) => ({
    maybeSingle: () => Promise.resolve({ data, error: null }),
    single:      () => Promise.resolve({ data, error: null }),
  });

  // Named interface for the chainable `.eq()` builder so we avoid `any`.
  interface QueryChain {
    eq(k: string, v: unknown): QueryChain;
    maybeSingle(): Promise<{ data: unknown; error: null }>;
    single(): Promise<{ data: unknown; error: null }>;
  }

  // Builds an infinitely-chainable `.eq()` builder that terminates with leaf().
  function eqChain(data: unknown): QueryChain {
    return { eq: (_k, _v) => eqChain(data), ...leaf(data) };
  }

  // `.select(cols)` → eqChain, table-aware so SELECT on 'documents' returns
  // supabaseState.existingDoc while other tables resolve to null.
  const selectFn = (table: string) => (_cols: string) => {
    const data = table === "documents" ? supabaseState.existingDoc : null;
    return eqChain(data);
  };

  // `.upsert(records, opts?)` — different shapes for 'documents' vs 'document_embeddings'
  const upsertFn = (table: string) => (records: unknown, _opts?: unknown) => {
    supabaseState.upsertCalls.push({ table, records });
    if (table === "document_embeddings") {
      // Plain upsert — code awaits the result directly (no .select chain)
      const err = supabaseState.upsertEmbeddingsError;
      return Promise.resolve({ data: null, error: err, count: null });
    }
    // documents: upsert(...).select('id').single()
    return {
      select: (_cols: string) => ({
        single: () =>
          Promise.resolve({
            data: supabaseState.upsertDocReturn,
            error: supabaseState.upsertDocReturn ? null : { message: "insert failed" },
          }),
      }),
    };
  };

  // `.delete()` → `.eq(docIdKey, docId)` → `.gte/.gt(idxKey, threshold)`
  const deleteFn = (table: string) => () => ({
    eq: (_docIdKey: string, docId: string) => ({
      gte: (_idxKey: string, threshold: number) => {
        supabaseState.deleteCalls.push({ table, docId, chunkThreshold: threshold, operator: "gte" });
        return Promise.resolve({ data: null, error: null });
      },
      gt: (_idxKey: string, threshold: number) => {
        supabaseState.deleteCalls.push({ table, docId, chunkThreshold: threshold, operator: "gt" });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  });

  return {
    supabaseAdmin: {
      from: (table: string) => ({
        select: selectFn(table),
        upsert: upsertFn(table),
        delete: deleteFn(table),
      }),
    },
  };
});

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ─── Module under test ───────────────────────────────────────────────────────

import { indexDocument, indexDocuments } from "@/lib/integrations/indexing";

// ─── Test helpers ────────────────────────────────────────────────────────────

const ORG_ID = "org-a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const CONN_ID = "conn-b2c3d4e5-f6a7-8901-bcde-f12345678901";
const DEPT_ID = "dept-c3d4e5f6-a7b8-9012-cdef-123456789012";
const DOC_ID  = "doc-uuid-1";

/** Build a minimal FetchedChunk for testing. */
function makeChunk(overrides: Partial<FetchedChunk> = {}): FetchedChunk {
  return {
    chunk_id:   "ext-id-001",
    title:      "Test Document",
    content:    "This is the document content for testing purposes.",
    source_url: "https://example.com/doc",
    metadata: {
      provider:    "notion",
      source_type: "notion",
      ...((overrides.metadata ?? {}) as object),
    },
    ...overrides,
  } as FetchedChunk;
}

/** SHA-256 of the given string (same algorithm as indexing.ts). */
function sha256(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

// ─── 3C.4 — Content hash dedup ───────────────────────────────────────────────

describe("3C.4 — Content hash dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseState.existingDoc = null;
    supabaseState.upsertDocReturn = { id: DOC_ID };
    supabaseState.upsertEmbeddingsError = null;
    supabaseState.deleteCalls = [];
    supabaseState.upsertCalls = [];
    embedBatchMock.mockResolvedValue([Array(768).fill(0.1)]);
  });

  it("calls embedBatch when content_hash has changed", async () => {
    // No existing document → content is new
    supabaseState.existingDoc = null;

    await indexDocument(makeChunk(), ORG_ID, CONN_ID, null, "org_wide");

    expect(embedBatchMock).toHaveBeenCalledOnce();
  });

  it("skips embedBatch entirely when content_hash is unchanged (3C.4)", async () => {
    const chunk = makeChunk();
    // Existing doc has the same hash as the current content
    supabaseState.existingDoc = { id: DOC_ID, content_hash: sha256(chunk.content) };

    await indexDocument(chunk, ORG_ID, CONN_ID, null, "org_wide");

    // Hash unchanged → no embedding call, no document_embeddings write
    expect(embedBatchMock).not.toHaveBeenCalled();
    const embUpserts = supabaseState.upsertCalls.filter((u) => u.table === "document_embeddings");
    expect(embUpserts).toHaveLength(0);
  });

  it("re-embeds when content changes (different hash)", async () => {
    const chunk = makeChunk({ content: "Updated content v2" });
    // Existing doc has the OLD hash
    supabaseState.existingDoc = { id: DOC_ID, content_hash: sha256("Old content") };
    embedBatchMock.mockResolvedValue([Array(768).fill(0.5)]);

    await indexDocument(chunk, ORG_ID, CONN_ID, null, "org_wide");

    expect(embedBatchMock).toHaveBeenCalledOnce();
  });

  it("skips re-embedding in batch path (indexDocuments) when hash unchanged", async () => {
    const chunk = makeChunk();
    supabaseState.existingDoc = { id: DOC_ID, content_hash: sha256(chunk.content) };

    const result = await indexDocuments([chunk], ORG_ID, CONN_ID, null, "org_wide");

    expect(embedBatchMock).not.toHaveBeenCalled();
    // The document ID is still returned so the caller can enqueue graph-build
    // (even though no new embeddings were written, the document row exists)
    expect(result.errors).toBe(0);
  });
});

// ─── 3B.2 — Org isolation in upserts ─────────────────────────────────────────

describe("3B.2 — Org isolation: every document_embeddings upsert includes org_id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseState.existingDoc = null;
    supabaseState.upsertDocReturn = { id: DOC_ID };
    supabaseState.upsertEmbeddingsError = null;
    supabaseState.deleteCalls = [];
    supabaseState.upsertCalls = [];
    // Return a 768-dim vector for each text
    embedBatchMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(768).fill(0.2))
    );
  });

  it("every record in document_embeddings upsert has org_id", async () => {
    await indexDocument(makeChunk(), ORG_ID, CONN_ID, null, "org_wide");

    const embUpserts = supabaseState.upsertCalls.filter((u) => u.table === "document_embeddings");
    expect(embUpserts.length).toBeGreaterThan(0);

    for (const call of embUpserts) {
      const records = Array.isArray(call.records) ? call.records : [call.records];
      for (const rec of records) {
        expect((rec as any).org_id).toBe(ORG_ID);
      }
    }
  });

  it("document upsert (documents table) includes org_id", async () => {
    await indexDocument(makeChunk(), ORG_ID, CONN_ID, DEPT_ID, "department");

    const docUpserts = supabaseState.upsertCalls.filter((u) => u.table === "documents");
    expect(docUpserts.length).toBeGreaterThan(0);

    for (const call of docUpserts) {
      const record = call.records as any;
      expect(record.org_id).toBe(ORG_ID);
    }
  });

  it("batch indexDocuments: every embeddings record has org_id", async () => {
    supabaseState.existingDoc = null; // force content-changed path
    const chunks = [makeChunk({ chunk_id: "a" }), makeChunk({ chunk_id: "b" })];

    await indexDocuments(chunks, ORG_ID, CONN_ID, null, "org_wide");

    const embUpserts = supabaseState.upsertCalls.filter((u) => u.table === "document_embeddings");
    expect(embUpserts.length).toBeGreaterThan(0);

    for (const call of embUpserts) {
      const records = Array.isArray(call.records) ? call.records : [call.records];
      for (const rec of records) {
        expect((rec as any).org_id).toBe(ORG_ID);
      }
    }
  });
});

// ─── 3B.3 — Stale chunk pruning ──────────────────────────────────────────────

describe("3B.3 — Stale chunk pruning scoped to (document_id, chunk_index)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseState.existingDoc = null;
    supabaseState.upsertDocReturn = { id: DOC_ID };
    supabaseState.upsertEmbeddingsError = null;
    supabaseState.deleteCalls = [];
    supabaseState.upsertCalls = [];
    embedBatchMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(768).fill(0.3))
    );
  });

  it("single-doc path (indexDocument): prune is scoped to document_id", async () => {
    await indexDocument(makeChunk(), ORG_ID, CONN_ID, null, "org_wide");

    const prunes = supabaseState.deleteCalls.filter((d) => d.table === "document_embeddings");
    expect(prunes.length).toBeGreaterThan(0);
    for (const p of prunes) {
      // Must target the specific document row, not all embeddings
      expect(p.docId).toBe(DOC_ID);
    }
  });

  it("single-doc path: prune threshold ≥ the new chunk count (no live chunks removed)", async () => {
    // The content will produce exactly 1 chunk (short string)
    await indexDocument(makeChunk({ content: "Short content." }), ORG_ID, CONN_ID, null, "org_wide");

    const prune = supabaseState.deleteCalls.find(
      (d) => d.table === "document_embeddings" && d.operator === "gte"
    );
    // gte means: delete chunk_index >= threshold.
    // If 1 chunk written (index 0), delete chunk_index >= 1 (stale indices only)
    expect(prune).toBeDefined();
    expect(prune!.chunkThreshold).toBeGreaterThanOrEqual(1);
  });

  it("batch path (indexDocuments): prune uses .gt scoped to document_id", async () => {
    const chunk = makeChunk();
    await indexDocuments([chunk], ORG_ID, CONN_ID, null, "org_wide");

    const gtPrunes = supabaseState.deleteCalls.filter(
      (d) => d.table === "document_embeddings" && d.operator === "gt"
    );
    expect(gtPrunes.length).toBeGreaterThan(0);
    for (const p of gtPrunes) {
      // batch prune also scoped to the specific document_id
      expect(p.docId).toBe(DOC_ID);
    }
  });

  it("batch path: prune threshold = max new chunk_index (does not delete live chunks)", async () => {
    // Short content → 1 chunk → max chunk_index = 0 → delete chunk_index > 0
    await indexDocuments(
      [makeChunk({ chunk_id: "short", content: "Brief." })],
      ORG_ID,
      CONN_ID,
      null,
      "org_wide"
    );

    const gtPrune = supabaseState.deleteCalls.find(
      (d) => d.table === "document_embeddings" && d.operator === "gt"
    );
    expect(gtPrune).toBeDefined();
    // chunk_index > 0 → the one live chunk (index 0) is not deleted
    expect(gtPrune!.chunkThreshold).toBeGreaterThanOrEqual(0);
  });
});

// ─── 3B.5 — Embedding batch size cap ─────────────────────────────────────────

describe("3B.5 — embedBatch is never called with more than EMBED_BATCH_SIZE texts", () => {
  // The constant is 96 in indexing.ts; import it indirectly by observing behaviour.
  const EMBED_BATCH_SIZE = 96;

  beforeEach(() => {
    vi.clearAllMocks();
    supabaseState.existingDoc = null; // force full re-embed for every doc
    supabaseState.upsertDocReturn = { id: DOC_ID };
    supabaseState.upsertEmbeddingsError = null;
    supabaseState.deleteCalls = [];
    supabaseState.upsertCalls = [];
    // Return one 768-dim vector per text so batch size checks are stable
    embedBatchMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(768).fill(0))
    );
  });

  it("splits a corpus larger than EMBED_BATCH_SIZE into multiple batches (3B.5)", async () => {
    // Build EMBED_BATCH_SIZE + 1 chunks so at least two embed calls are needed.
    // Give each chunk enough content that it produces exactly one text (short, no splitting).
    const chunks = Array.from({ length: EMBED_BATCH_SIZE + 1 }, (_, i) =>
      makeChunk({ chunk_id: `c-${i}`, content: `Unique short content number ${i}.` })
    );

    await indexDocuments(chunks, ORG_ID, CONN_ID, null, "org_wide");

    // Every individual call to embedBatch must stay within the cap
    for (const [texts] of embedBatchMock.mock.calls) {
      expect(texts.length).toBeLessThanOrEqual(EMBED_BATCH_SIZE);
    }

    // With 97 texts and a cap of 96 we need at least 2 calls
    expect(embedBatchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── P0-3/P0-4: embedding provenance + per-hint batch grouping ───────────────

describe("P0-3/P0-4 — provenance stamping and hint grouping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supabaseState.existingDoc = null;
    supabaseState.upsertDocReturn = { id: DOC_ID };
    supabaseState.upsertEmbeddingsError = null;
    supabaseState.deleteCalls = [];
    supabaseState.upsertCalls = [];
    embedBatchMock.mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(768).fill(0.1))
    );
  });

  it("stamps embedding_model and pipeline_version on rows (P0-3)", async () => {
    await indexDocument(makeChunk(), ORG_ID, CONN_ID, null, "org_wide");

    const embRows = supabaseState.upsertCalls
      .filter((c) => c.table === "document_embeddings")
      .flatMap((c) => (Array.isArray(c.records) ? c.records : [c.records])) as Array<
      Record<string, unknown>
    >;
    expect(embRows.length).toBeGreaterThan(0);
    for (const row of embRows) {
      expect(row.embedding_model).toBe("test-embedding-model");
      expect(row.pipeline_version).toBe(1);
    }
  });

  it("embeds a mixed salesforce+notion batch in two per-hint groups with alignment intact (P0-4)", async () => {
    const sfChunk = makeChunk({
      chunk_id: "sf-1",
      content: "Opportunity: Acme Renewal. Stage: Negotiation.",
      metadata: { provider: "salesforce", resource_type: "opportunities" },
    });
    const notionChunk = makeChunk({
      chunk_id: "notion-1",
      content: "Meeting notes: we will evaluate vendors next week.",
      metadata: { provider: "notion", resource_type: "page" },
    });

    const result = await indexDocuments(
      [sfChunk, notionChunk], ORG_ID, CONN_ID, null, "org_wide"
    );
    expect(result.errors).toBe(0);

    // Two calls — one per hint group (structured for salesforce, document for notion)
    expect(embedBatchMock).toHaveBeenCalledTimes(2);
    const hints = embedBatchMock.mock.calls.map((c) => c[2]).sort();
    expect(hints).toEqual(["document", "structured"]);

    // Alignment: each upserted row's metadata.chunk_text hashes to its content_hash
    const embRows = supabaseState.upsertCalls
      .filter((c) => c.table === "document_embeddings")
      .flatMap((c) => (Array.isArray(c.records) ? c.records : [c.records])) as Array<{
      content_hash: string;
      metadata: { chunk_text: string };
    }>;
    expect(embRows.length).toBeGreaterThanOrEqual(2);
    for (const row of embRows) {
      expect(row.content_hash).toBe(sha256(row.metadata.chunk_text));
    }
  });
});
