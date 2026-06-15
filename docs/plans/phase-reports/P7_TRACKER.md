# P7 Tracker — Hardening fast-follows (program exit)

_Phase 7 of `PHASE_EXECUTION_PLAYBOOK.md`. The hardening layer: encryption, the
sovereignty embedding lane, license/CI gates, and closing the audit defect
register. One row per ticket; detail below._
_Branch: `pipeline/p7-hardening-final` (P7-1 already on `main` via `282ee1a`) ·
Flag: `CHUNK_TEXT_ENCRYPTION` (default OFF) · Completed: 2026-06-16_

## Tickets

| ID | Title | Status | Size | Maps |
|----|-------|--------|------|------|
| P7-1 | chunk_text encryption flip — per-org AES-256-GCM + re-encryption job; content_preview redaction; vector-search decrypt boundary | **done** (merged `282ee1a`) | L | item 1 |
| P7-2 | Sovereignty embedding lane — TEI provider + nomic/BGE **prefix task mapping** (`search_document:`/`search_query:`), wired off `embedding_model_pinned`; deploy recipe | **done** | M | item 2 |
| P7-3 | License allow-list CI scanner (`check:licenses`) + allow-list; sidecar image-scan / load-test / SOC-2 evidence documented as ops | **done** (scanner) | M | item 3 |
| P7-4 | Close audit defect register D1–D12 (closure table); P7 report + program-exit gate; flag-cleanup plan | **done** | M | item 4 |

---

## Session notes

### P7-1 — chunk_text encryption (prior session, on `main`)
Per-org AES-256-GCM via `deriveOrgKey` (same KMS scheme as BYOK); self-identifying
`encv1:` envelope; GCM tamper → null; plaintext passthrough for mixed-row migration.
`writeChunkText(orgId)` encrypts, `readChunkText` decrypts via `row.org_id`,
`content_preview` redacted; `vector.ts` decrypts at the single retrieval boundary;
`re-encrypt.ts` paged/resumable migration. Behind `CHUNK_TEXT_ENCRYPTION`. 15 tests.

### P7-2 — sovereignty embedding lane (2026-06-16)
- **`tei` provider** in `embedding-factory.ts` — self-hosted text-embeddings-inference,
  reuses the OpenAI-compatible `/v1/embeddings` path; `resolveTeiConfig` reads `TEI_URL`
  (+ `TEI_MODEL`, `TEI_API_KEY`). Wired into `resolveSystemConfig` (last-resort default)
  + `resolvePinnedConfig` (checked **before** external APIs, so a sovereignty-pinned org
  never leaks).
- **Prefix task mapping** (`applyPrefixTask`) — TEI-served retrieval models signal the
  task by prefixing the text (`search_query: ` / `search_document: `), not via an API
  task param. Wired off `EmbeddingHint`. Idempotent (never double-prefixes).
- **Regression-safe scoping (review fix):** `needsPrefixTask` is gated to
  `provider === 'tei'` + a prefix-family model **only**. The existing nomic-API and
  local-BGE lanes are left UNCHANGED — retroactively prefixing them would mismatch
  their already-stored (un-prefixed) passages until a re-embed (silent semantic
  drift). TEI is a new lane with no stored data → correct from day one. Pinned-config
  routes to TEI only on an explicit `tei`/`tei-*` pin (not a bare model-name match),
  so a nomic-API org is never silently rerouted. 4 regression-guard tests added.
- Activation is the existing `embedding_model_pinned` switch — **no new flag**; inactive
  until `TEI_URL` is set. Same code path → light-up is config + re-embed.
- `SOVEREIGNTY_LANE_RECIPE.md`: TEI/nomic Docker deploy + activation + verification +
  rollback. Scope: serving wired+tested; cluster deploy is ops.
- **Tests:** `sovereignty-prefix.test.ts` (6) — query/document/structured prefixing,
  batch order, idempotency, asymmetry. Existing 12 factory tests green.

### P7-3 — license CI gate (2026-06-16)
- `scripts/check-licenses.mjs` (mirrors `check-rls.mjs`): scans every prod dependency's
  installed license against a permissive allow-list (MIT/Apache-2.0/BSD/ISC/0BSD/
  Unlicense/CC0/MPL-2.0/…); fails on copyleft (GPL/AGPL/LGPL) or unknown unless the
  package is explicitly allow-listed with a justification.
- `scripts/license-allowlist.txt`: 3 entries (`@nangohq/frontend`, `@nangohq/node`,
  `@browserbasehq/sdk`) — non-SPDX `license` fields, repo LICENSE verified MIT.
- `npm run check:licenses` → **67 prod deps: 64 permissive, 3 allow-listed, exit 0.**
- **Documented as ops** (not code, infra-gated like prior phases): sidecar image
  vulnerability scan, sidecar load test ≥ LlamaParse-baseline throughput, SOC-2 evidence
  (sidecar network policy, no-persistence attestation, pen-test ticket).

### P7-4 — defect register + gate (2026-06-16)
- `DATA_PIPELINE_AUDIT_V2.md §6.1` — **D1–D12 closure table**: each defect → closing
  phase + mechanism + activating flag. All 12 closed.
- This tracker + the program-exit gate below.
- **Flag-cleanup plan (documented-deferred):** the P1–P6 flags + the legacy
  provider-string sets (`RECORD/TABULAR/THREAD_SOURCE_TYPES`) are removed only after a
  feature is rolled out ≥2 releases (playbook rule "no permanent flags"). Not done now —
  nothing has shipped 2 releases yet. Tracked as the final cleanup.

---

## Program-exit gate (criteria + status)

| Criterion | Status |
|---|---|
| Encryption available for pilot org, all features green | ✅ `CHUNK_TEXT_ENCRYPTION` + re-encrypt job; verified by tests (live enable = ops) |
| Defect register D1–D12 fully closed | ✅ §6.1 closure table — all 12 mapped to closing phase + flag |
| Sovereignty lane tested org-end-to-end | ✅ TEI provider + prefix mapping wired + unit-tested; live deploy = ops (`SOVEREIGNTY_LANE_RECIPE.md`) |
| License/CI gate | ✅ `check:licenses` green (67 deps); image-scan/load-test/SOC-2 documented as ops |
| Cumulative ≥25% recall@5 over P0 baseline across shapes | ⏳ **infra-gated** — needs the deployed sidecar + pilot re-embed + eval run (batched with the P1–P6 gate measurements in `P3_PILOT_RUNBOOK.md`); the mechanisms are all in place |
| Runbooks (key rotation, scope rebuild, re-embed, sidecar outage) exercised once | ⏳ docs exist (`SOVEREIGNTY_LANE_RECIPE`, `FEATURE_ROLLOUT_RUNBOOK`, rebuild-scopes endpoint, re-embed.ts); live drills = ops |

**Program status:** P0–P7 are **code-complete** — all eight phases merged to `main`,
all behind default-OFF flags, D1–D12 closed, full suite + tsc + all CI gates green.
The remaining program-exit items (live recall measurement, runbook drills, sidecar
deploy, flag cleanup ≥2 releases out) are **operational/infra**, not code, and are
the same single batched validation that every phase's quantitative gate depends on.

## Rollback
`CHUNK_TEXT_ENCRYPTION` off → plaintext chunk_text (mixed rows read fine). Sovereignty
lane: unset `TEI_URL` / re-pin to jina + re-embed. License gate: pure CI, no runtime
effect. All additive — nothing here changes legacy behavior with flags off.
