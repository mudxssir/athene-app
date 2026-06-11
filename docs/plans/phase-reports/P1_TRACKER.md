# P1 Tracker — Shape Routing Sidecar Chunk

_Sprint-style tracker for Phase 1 of `PHASE_EXECUTION_PLAYBOOK.md`. One row per ticket;
detail blocks below. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p1-shape-routing-sidecar-chunk` · Flag: `PIPELINE_SHAPE_ROUTING` (default OFF) · Started: 2026-06-11_

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P1-1 | `DataShape` type + `FetchedChunk.shape` required | done (`05406c4`) | XS | P0 |
| P1-2 | Stamp `shape` on all 35+ fetcher files | done (`05406c4`) | M | P1-1 |
| P1-3 | Shape-aware `chunkContent` + `resolveEmbeddingHint` in `indexing.ts` | done (`05406c4`) | M | P1-1 |
| P1-4 | `extractionTier(shape)` → `'A'|'B'|'C'` + gate in `indexer.ts` | done (`05406c4`) | S | P1-1 |
| P1-5 | `computeSignals(text)` — structural signal extraction | done | S | P1-1 |
| P1-6 | `selectStrategy(shape, signals)` — per-document chunk plan | done | S | P1-5 |
| P1-7 | `splitByHeadings` + `splitFenceAtomic` + `groupIntoParents` | done | M | P1-6 |
| P1-8 | `parent_chunk_index` column + vector_search parent JOIN | done | M | P1-7 |
| P1-9 | `embedBatchLateChunking` + late-chunking wiring in `indexDocument` | done | S | P1-8 |
| P1-10 | FastAPI sidecar scaffold (`services/athene-parse/`) | done | M | — |
| P1-11 | `sidecar-client.ts` — circuit breaker, 120 s timeout, 80 MB cap | done | S | P1-10 |
| P1-12 | Shadow mode — structural-diff logging vs inline parser | done | XS | P1-11 |
| P1-13 | `embedding_model_pinned` + `needs_embedding` + embed-retry worker | done | M | P1-9 |
| P1-14 | `scripts/migrations/re-embed.ts` — paced resumable re-embed | done | S | P1-13 |
| P1-15 | vector_search model filter + CI mixed-model assertion | done | S | P1-13 |

**Session notes (2026-06-11):**

### P1-1: DataShape + FetchedChunk interface

`lib/integrations/base.ts`:
- `DataShape` union: `'prose'|'email'|'thread'|'work_item'|'record'|'tabular'|'bi_artifact'|'media'|'code'`
- `FetchedChunk.shape: DataShape` — required (TS enforced across all 35+ call sites)
- `StructuredOwner` and `ChunkContext` added as Phase 2/3 placeholder interfaces

### P1-2: shape on all fetchers

All 35+ fetcher files updated (plus all searcher files and misc chunk constructors):

| Provider | Shape assigned |
|----------|---------------|
| Notion pages, Confluence, Drive, wiki, Zendesk articles, HubSpot notes | `prose` |
| Gmail, Outlook, MS email | `email` |
| Slack channels | `thread` |
| Jira, GitHub issues/PRs, Linear issues, Zendesk tickets, Salesforce cases | `work_item` |
| Calendar (Google + MS), Linear projects/cycles, Salesforce accounts/contacts/opps, HubSpot deals/companies/contacts | `record` |
| Snowflake, BigQuery, Redshift | `tabular` (via `bi-chunking.ts` builders) |
| Looker, Metabase, Tableau, dbt, PowerBI | `bi_artifact` |

Searcher files (`**/searcher.ts`), `tabular-analysis.ts`, `app/api/files/upload/route.ts`,
and `app/api/test/pipeline/route.ts` also fixed (TypeScript demanded it since `shape` is required).

### P1-3: shape-aware chunking + embedding hint

`lib/integrations/indexing.ts`:
- `chunkContent(content, shape?, legacyProvider?)` — when `PIPELINE_SHAPE_ROUTING && shape`, dispatches by `DataShape`:
  - `record` → no split (≤ 3000 chars) or email-style sentence chunker
  - `tabular` / `bi_artifact` → no split (≤ 4000) or 768/96 token chunks
  - `email` → char-based chunker (2000/200)
  - `thread` / `work_item` → 768/128 token chunks
  - `media` → single passthrough
  - `prose` / `code` → 512/64 token chunks (default)
- When flag is OFF or shape is absent → legacy provider-string dispatch + `[indexing] legacy-routing` warn log
- `resolveEmbeddingHint(shape?, legacyProvider?)` updated to match
- Both `indexDocument` and `indexDocuments` call sites updated
- `scripts/eval/run-eval.ts` Pipeline type + call sites updated

### P1-4: extractionTier

`lib/knowledge-graph/extraction-gate.ts`:
- `extractionTier(shape, chunkTexts): 'A'|'B'|'C'`
  - Tier A: `prose`, `email`, `work_item` → always full LLM extraction
  - Tier B: `thread` (signal-pattern gated) / `record` (description > 200 chars) → LLM only when promoted
  - Tier C: `tabular`, `bi_artifact`, `media`, `code` → deterministic only, no LLM

`lib/langgraph/tools/indexer.ts`:
- `IndexDocumentInput.shape?: DataShape` field added
- Gate condition: `PIPELINE_SHAPE_ROUTING && shape ? extractionTier(shape, ...) === 'C' : !shouldRunExtraction(...)`
- Tier B (thread, no signal) still skips just like the legacy Slack gate

### P1-5 + P1-6: chunk-policy engine

`lib/indexing/chunk-policy.ts` (new):
- `computeSignals(text): ChunkSignals` — pure signal extraction (tokens, headingDensity, tableDensity, codeFenceRatio, sentenceLen, listRatio) using gpt-tokenizer
- `selectStrategy(shape, signals): ChunkPlan` — dispatches to correct strategy:
  - tokens ≤ noSplitCeiling → passthrough
  - prose + codeFenceRatio > 0.3 → fence-atomic (512/0.05)
  - prose + headingDensity ≥ 1.0 → structural
  - prose heading-poor → token (512/0.10)
  - code → fence-atomic always
  - all other shapes → token with per-shape budget from PLAN_A §0.4
- Constants: `TRUNCATE_TOKEN_CAP=200_000`, `MIN_TOKENS=64`, `MAX_CHUNKS_PER_DOC=400`
- BASE_PLANS per shape match PLAN_A §0.4 token budgets

### P1-7: structural chunkers

`lib/indexing/structural-chunker.ts` (new):
- `splitByHeadings(markdown, minTokens)` — H1–H4 heading-tree splitter with breadcrumb trails; fence-protected; merges tiny sections into predecessor
- `groupIntoParents(sections, parentTarget)` — greedy binning into ~parentTarget-token parent windows
- `splitFenceAtomic(text, targetTokens, overlapFraction)` — token-window chunker; code fences are atomic units never split across chunks

### P1-8: small-to-big retrieval DB layer

`supabase/migrations/20260611000004_parent_chunk_index.sql`:
- `document_embeddings.parent_chunk_index int` column + covering index
- Deploy BEFORE code that writes parent_chunk_index (PostgREST rejects unknown columns)

`supabase/migrations/20260611000005_vector_search_parent.sql`:
- Rewrites `vector_search` and `vector_search_cross_dept` with:
  - LEFT JOIN on parent row when `parent_chunk_index IS NOT NULL`
  - `WHERE de.embedding IS NOT NULL` to exclude parent-only rows from search
  - Fallback chain: parent text → child text → content_preview → ''
  - New `parent_chunk_index` column in return type

`lib/integrations/indexing.ts`:
- `indexDocument` structural branch: parent rows (chunk_index 0..nParents-1, embedding=null) then child rows (chunk_index nParents+, with parent_chunk_index=gi)
- `indexDocuments` bulk path: `parent_chunk_index: null` on all rows (structural docs should go through `indexDocument`)

### P1-9: late chunking

`lib/ai/embedding-factory.ts`:
- `embedWithJina` gains `lateChunking` param → `late_chunking: true` added to Jina request
- `embedBatchLateChunking(texts, orgId, hint)` — wraps Jina with fallback to `embedBatchDetailed` on any failure

`lib/integrations/indexing.ts`:
- `LATE_CHUNKING_SHAPES = new Set(['prose', 'email', 'thread', 'work_item'])`
- Structural branch: `useLateChunking = LATE_CHUNKING_SHAPES.has(shape) && childTexts.length > 1`
- Standard path: same gate + `generateEmbeddings(..., useLateChunking)`

### Test coverage

| File | Tests | Notes |
|------|-------|-------|
| `lib/integrations/__tests__/indexing-shape-routing.test.ts` | 29 | Updated for policy engine; flag-ON passthrough + chunked; flag-OFF legacy |
| `lib/knowledge-graph/__tests__/extraction-tier.test.ts` | 16 | All shapes, Tier A/B/C, promotion logic |
| `lib/indexing/__tests__/chunk-policy.test.ts` | 20 | computeSignals + selectStrategy |
| `lib/indexing/__tests__/structural-chunker.test.ts` | 22 | splitByHeadings + splitFenceAtomic + groupIntoParents |

All 89 tests pass. Zero regressions.

### Type health

`npx tsc --noEmit` — 0 errors after fixing all call sites. The `shape` field being required on
`FetchedChunk` acts as a compile-time guard: every future fetcher that omits it will fail CI.

### P1-10: FastAPI sidecar scaffold

`services/athene-parse/` (new Python service):
- `main.py`: FastAPI app with `/healthz`, `/parse`, `/chunk`
  - `/parse`: Docling primary → MarkItDown fallback → plain-text last resort
  - `/chunk`: Chonkie semantic chunking → naive paragraph fallback
  - Bearer-token auth middleware (`SIDECAR_AUTH_TOKEN`); `/healthz` exempt
  - 80 MB byte-size cap enforced before any parsing
  - No disk writes beyond temp files (auto-deleted); no content in logs
- `Dockerfile`: pinned `python:3.12.8-slim`, multi-stage, non-root user
- `requirements.txt`: pinned versions (`docling==2.15.0`, `markitdown==0.0.1a3`, `chonkie[semantic]==0.4.2`)
- `tests/test_main.py`: 7 pytest tests (healthz, auth, plain-text fallback, 80 MB rejection, chunking)

### P1-11: Sidecar TypeScript client

`lib/integrations/sidecar-client.ts` (new):
- `parseSidecar(buffer, filename, orgId?)` → `ParseResult | null`
- `chunkSemantic(text, targetTokens, overlapTokens?)` → `ChunkResult | null`
- `sidecarAvailable()` — pre-flight check (configures + CB state)
- Circuit breaker: 3 consecutive failures → open 5 min → half-open test
- 120 s `AbortController` timeout per request
- Env vars read lazily (inside functions) so tests can override via `process.env`
- `_circuitBreakerState()` / `_resetCircuitBreaker()` exported for tests

### P1-12: Shadow mode

`lib/integrations/sidecar-shadow.ts` (new):
- `maybeShadowParse(inlineMarkdown, rawBuffer, filename, orgId?)` — never throws
- Sample rate: `SIDECAR_SHADOW_RATE` env var (0 = disabled, 0.05 = 5%)
- Logs: `heading_delta`, `table_delta`, `fence_delta`, `parser_used`, `duration_ms`
- Indexed content always comes from inline parser; sidecar is comparison-only

### P1-13: Embedding model pinning

`supabase/migrations/20260612000001_embedding_pinning.sql`:
- `organizations.embedding_model_pinned text NOT NULL DEFAULT 'jina-embeddings-v3'`
- `document_embeddings.needs_embedding bool NOT NULL DEFAULT false` + covering index
- `migration_jobs` table (paced re-embed checkpoints, org-scoped)
- `sync_errors` table (DLQ for all background job failures, admin-visible)

`lib/ai/embedding-factory.ts`:
- `fetchOrgPinnedModel(orgId)` — reads org's pinned model from DB
- `embedBatchPinned(texts, orgId, hint?, lateChunking?)` — uses only pinned model; throws on failure (no cross-model fallback); local BGE when `pinned='bge-base-en-v1.5-local'`

`lib/integrations/indexing.ts`:
- `generateEmbeddings`: when `PIPELINE_SHAPE_ROUTING && orgId` → uses `embedBatchPinned`; on throw → writes null-embedding placeholders with `needs_embedding=true` + enqueues `embed-retry` QStash job (idempotency: `org:embed-retry:document_id`)

`app/api/worker/embed-retry/route.ts` (new):
- QStash worker, payload `{ org_id, document_id }`
- Fetches all `needs_embedding=true` rows, re-embeds via `embedBatchPinned`
- Batch 96, DLQ to `sync_errors` on failure

### P1-14: Paced re-embed script

`scripts/migrations/re-embed.ts` (new):
- CLI: `npx tsx scripts/migrations/re-embed.ts --org <uuid> [--resume] [--dry-run]`
- Per-org concurrency 1, batch 96, checkpoint every 500 docs in `migration_jobs`
- Filters: `embedding_model != pinned` (only rows needing migration)
- Idempotent: re-running re-processes only stale rows
- `--resume` resumes from `last_doc_id` cursor in existing `migration_jobs` row

### P1-15: Vector search model pinning

`supabase/migrations/20260612000002_vector_search_model_filter.sql`:
- `vector_search` and `vector_search_cross_dept` gain `p_model_filter text DEFAULT NULL`
- `WHERE (p_model_filter IS NULL OR de.embedding_model = p_model_filter)`
- `AND de.needs_embedding = false` — excludes P1-13 retry-pending rows from search
- Backward-compatible: existing 3-arg and 2-arg callers still work

`scripts/check-model-pinning.mjs` (new):
- CI assertion: finds orgs with `>1` distinct `embedding_model` among searchable rows
- Exit 0 = all orgs consistent; Exit 1 = mixed models detected (with org list)

### Test coverage (P1-10 through P1-15)

| File | Tests | Notes |
|------|-------|-------|
| `services/athene-parse/tests/test_main.py` | 7 | Python pytest; healthz, auth, 80 MB cap, parse fallback, chunk |
| `lib/integrations/__tests__/sidecar-client.test.ts` | 10 | CB state transitions, null on failure, success paths |

All 137 TS tests pass. Zero TypeScript errors.

### What's NOT in P1

- Sidecar chunk API (P2): separate request to extraction sidecar with structured output
- Shape-aware migration / reindex worker (P3): bump `PIPELINE_VERSION` + backfill
- `MIXED MODELS` resolution (P3): shape pinning to model variant
- Test baseline re-recording: requires live Jina API keys; `p0.json` marked stale
