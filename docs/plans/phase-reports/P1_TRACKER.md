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

### Test coverage

| File | Tests | Notes |
|------|-------|-------|
| `lib/integrations/__tests__/indexing-shape-routing.test.ts` | 24 | chunkContent flag-on/off + resolveEmbeddingHint |
| `lib/knowledge-graph/__tests__/extraction-tier.test.ts` | 16 | All shapes, Tier A/B/C, promotion logic |

All 40 new tests pass. Zero regressions (pre-existing 24 failures confirmed on base branch before P1).

### Type health

`npx tsc --noEmit` — 0 errors after fixing all call sites. The `shape` field being required on
`FetchedChunk` acts as a compile-time guard: every future fetcher that omits it will fail CI.

### What's NOT in P1

- Sidecar chunk API (P2): separate request to extraction sidecar with structured output
- Shape-aware migration / reindex worker (P3): bump `PIPELINE_VERSION` + backfill
- `MIXED MODELS` resolution (P3): shape pinning to model variant
- Test baseline re-recording: requires live Jina API keys; `p0.json` marked stale
