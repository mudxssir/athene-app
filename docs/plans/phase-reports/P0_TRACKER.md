# P0 Tracker — Stop the Bleeding

_Sprint-style tracker for Phase 0 of `PHASE_EXECUTION_PLAYBOOK.md`. One row per ticket;
detail blocks below. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p0-stop-the-bleeding` · Flag(s): none (P0 is patch-level) · Started: 2026-06-11_

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P0-1 | Decision extraction: add missing source keys | todo | XS | — |
| P0-2 | Query-time embedding hint (`'query'`) end to end | todo | S | — |
| P0-3 | Migration: `embedding_model`, `pipeline_version`, `shape` columns | todo | S | — |
| P0-4 | Group embedding batches by hint | todo | S | P0-3 |
| P0-5 | Stop indexing skip-sentinels + `sync_skips` telemetry | todo | M | — |
| P0-6 | `chunk-text-store.ts` encrypt-capable helper + refactor readers/writers | todo | M | — |
| P0-7 | Fallback-activation + normalize-strip telemetry | todo | S | P0-3 |
| P0-8 | Eval harness + per-shape golden sets + recorded baselines | todo | L | P0-1..P0-5 |

---

## P0-1 — Decision extraction: add missing source keys
**Problem:** `DECISION_SOURCE_TYPES` keys on `gmail`/`google_drive`/`sharepoint`/`file_upload`,
which no fetcher emits (audit D1). Decision memory silently dead for those sources.
**Change:** `lib/knowledge-graph/extractor-prompt.ts` — add `google`, `microsoft`,
`direct_upload` to the set, with an `// interim until shape routing (P1)` comment.
**Acceptance criteria:**
- [ ] Unit test: `DECISION_SOURCE_TYPES.has('google'|'microsoft'|'direct_upload')` true.
- [ ] Fixture test: extraction over a Drive-sourced chunk (`source_type:'google'`) invokes
      the decision prompt path (spy on `llmExtract` call count = 2).
**Risk:** more LLM calls on email/drive volume — accepted (quality-first); monitor via P0-7.

## P0-2 — Query-time embedding hint end to end
**Problem:** No call site passes `'query'`; Jina path hardcodes `retrieval.passage` (D5).
**Change:**
- `lib/ai/embedding-factory.ts`: `embedWithJina(texts, config, hint)` → `task:
  hint === 'query' ? 'retrieval.query' : 'retrieval.passage'`; pass hint through
  `callProviderWithRetry` jina case.
- `lib/tools/vector-search.ts` (2 call sites), `lib/knowledge-graph/entity-resolver.ts:129`:
  `embed(q, orgId, 'query')`.
**Note:** node-label embeddings remain passage-side; query/passage is the intended
asymmetric pairing. Symmetric `text-matching` for label↔label is a P1+ consideration.
**Acceptance criteria:**
- [ ] Unit test: Jina request body carries `task: 'retrieval.query'` when hint is query,
      `retrieval.passage` otherwise.
- [ ] Type check + existing vector-search tests green.

## P0-3 — Migration: provenance columns on document_embeddings
**Change:** SQL migration adding `embedding_model text`, `pipeline_version int NOT NULL
DEFAULT 1`, `shape text` (nullable) to `document_embeddings`; both index paths stamp
`embedding_model` from the resolved provider config and `pipeline_version` from a new
`PIPELINE_VERSION` const in `indexing.ts`.
**Acceptance criteria:**
- [ ] Migration applies + rolls back cleanly on staging.
- [ ] New rows carry model + version; existing rows backfilled `NULL` (meaning "pre-P0",
      handled by P1 re-embed).
- [ ] No RLS change required (columns only) — `check-rls.mjs` green.

## P0-4 — Group embedding batches by hint
**Problem:** `indexDocuments` derives one hint from the first changed item (D9); Microsoft
sync mixes shapes in one array.
**Change:** `indexing.ts` phase 3: partition `changedItems` by `resolveEmbeddingHint(...)`,
embed per partition, reassemble preserving template alignment.
**Acceptance criteria:**
- [ ] Unit test with a mixed salesforce+notion batch: two embed calls, hints
      `structured`/`document`, row→embedding alignment intact (compare content_hash map).
- [ ] No batch >96 texts per call (existing invariant preserved).

## P0-5 — Stop indexing skip-sentinels + sync_skips telemetry
**Problem:** `[Unsupported file type…]` sentinels become embedded documents on the
Microsoft/upload paths; Drive drops silently (D11/D12 partial).
**Change:**
- Shared `isSkipSentinel(content)` in `lib/integrations/base.ts`; the indexing entry point
  drops sentinel chunks: upsert document row with `metadata.skipped_reason`, write **no**
  embeddings.
- Migration: `sync_skips(id, org_id, connection_id, document_external_id, reason, created_at)`
  (service-role write, admin read RLS); writes from the drop path + Drive's existing skip
  branches.
**Acceptance criteria:**
- [ ] Fixture: a `.pptx`-without-LlamaParse upload produces 0 embedding rows, 1 sync_skips
      row, document row flagged.
- [ ] Delta-sync regression: re-running the sync does not duplicate skips (idempotent on
      external_id + reason).
- [ ] Admin sync-health page shows skip counts (read endpoint + minimal UI row).

## P0-6 — chunk-text-store helper
**Problem:** chunk text reads/writes are scattered (`indexing.ts` ×2, `builder.ts`,
diff-agent); P7 encryption needs one choke point.
**Change:** `lib/indexing/chunk-text-store.ts`:
```ts
writeChunkText(meta: Record<string, unknown>, text: string): Record<string, unknown>
readChunkText(row: { metadata?: unknown; content_preview?: string|null }): string | null
```
Plaintext passthrough now (`metadata.chunk_text`); all four call sites refactored through it;
`readChunkText` encapsulates the existing preview fallback.
**Acceptance criteria:**
- [ ] Grep gate: no direct `chunk_text` literal outside the store + its tests
      (CI grep check added to `package.json` lint step).
- [ ] Builder short-text fallback behavior unchanged (existing tests green).

## P0-7 — Degradation telemetry
**Change:**
- `embedding-factory.ts`: counter/log when the provider actually used ≠ first candidate
  (fallback activated), including provider names, org, batch size.
- `indexing.ts`: when `normalizeContent` removes >5% of bytes, log doc external_id + ratio
  (D8 exposure measurement — informs the P3 fix).
**Acceptance criteria:**
- [ ] Logs are content-free (ids + counts only).
- [ ] Synthetic test: failing primary key env → fallback log emitted once per batch.

## P0-8 — Eval harness + baselines
**Change:** `scripts/eval/`:
- `fixtures/` — per-shape corpora from pilot-org-shaped synthetic data (≥50 queries × 5
  shapes: prose, email, work_item, thread, tabular) with relevance labels.
- `run-eval.ts` — index fixtures into a scratch org, run recall@5 / MRR, write JSON to
  `docs/plans/phase-reports/baselines/p0.json`.
- npm script `eval:retrieval`; nightly CI job (not per-PR).
**Acceptance criteria:**
- [ ] Two consecutive runs differ <2% (determinism sanity).
- [ ] Baseline JSON committed; P1 gate references it.
- [ ] Runner enforces single `embedding_model` in scratch org (uses P0-3 column).

---

## Phase gate (exit to P1)
- [ ] All tickets `done`, ACs checked.
- [ ] Baselines recorded in `baselines/p0.json`.
- [ ] Zero new mixed-model rows since deploy (SQL check).
- [ ] Decision nodes appear from a Gmail-source fixture (D1 regression).
- [ ] Rollback drill: revert P0-1/P0-2 commits on a branch, tests still green (proves
      independence).
- [ ] Phase report written: `docs/plans/phase-reports/P0.md` (numbers, dates, deviations).
