# P4 Tracker — BI + CRM Group Depth (warehouses / BI tools / Salesforce / HubSpot / Zendesk / calendars)

_Sprint-style tracker for Phase 4 of `PHASE_EXECUTION_PLAYBOOK.md`. One row per ticket;
detail blocks below. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p4-bi-crm-depth` (off `pipeline/p3-docs-email-depth`) · Flags: `TABULAR_TIER_C` (default OFF) · Started: 2026-06-13_

## Tabular determinism

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P4-4 | Type-inference hardening: 95th-percentile rule replaces `every()` in `tabular-analysis.ts inferSchema` | done | S | — |
| P4-1 | D2: builder Tier C path — `extractSchemaEntities` for tabular (0 LLM); bi_artifact deterministic service/metric nodes; media inherits parent | done (tabular schema path; bi_artifact-name nodes folded into P4-5) | M | P4-4 |
| P4-3 | Wide tables: column-group splits (30 cols) + table-name header re-emit; PII masking flag for sample chunks (stats unaffected) | done (in-chunk grouping; physical multi-chunk split deferred) | M | P4-4 |
| P4-2 | Vocabulary enrichment: 1 simple-tier call/table → alias line in stats header (cached by schema hash); warehouse column comments | todo | M | P4-1 |

## bi_artifact split

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P4-5 | Looker/Metabase/Tableau/PowerBI/dbt: artifact-metadata → `bi_artifact`; row samples → `tabular`; DAX/LookML/SQL → fence-atomic | todo | M | P4-1 |

## Records

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P4-6 | Calendars → record shape (D3): structured_fields (attendees/organizer/start/end/recurrence); attendee WORKS_ON edges gated ≥2 internal; recurring master+next; declined/cancelled extraction-skipped | todo | M | P2 identity |
| P4-7 | CRM deterministic field edges: SF/HubSpot owner→OWNS (identity), account→TIED_TO_ACCOUNT; oversized field-group split; raw numerics in metadata | done (Salesforce; HubSpot owner-id resolution deferred) | M | P2 identity |
| P4-8 | Record Tier B rule: description >200 chars → gated LLM; else deterministic only | done (gate from P1 gap-closure, verified + chained-path tests; "deterministic only" half = P4-7 edges) | S | P4-1 |

---

## Defects closed this phase

| Defect | Title | Closed by |
|--------|-------|-----------|
| D2 | `extractSchemaEntities` dead code — BI tables get LLM noise instead of deterministic schema graph | P4-1 |
| D3 (verify) | Calendars never get record chunking / structured_fields (closed by shape in P1; structured-field + edge depth here) | P4-6 |

---

## Session notes

### P4-7: CRM deterministic field edges (2026-06-14)

- **`crm-structured.ts`** (`crmStructuredMetadata`): turns the deterministic CRM
  fields a fetcher already has (owner name/email/id, account name) into the
  metadata keys the builder consumes — `structured_owners` (owner → OWNS, reusing
  the P2 shape) + `structured_account`. One-line spread per fetcher.
- **`structured-records.ts`** (`buildStructuredRecordGraph`): record self node
  (resource_type → entity_type: opportunity/deal→`deal`, contact→`contact`,
  account→`account`, case→`ticket`), owner → OWNS → record, record →
  TIED_TO_ACCOUNT → account. All EXTRACTED/1.0, no LLM. Visibility split mirrors
  P2-5: record + edges inherit doc visibility; person/account nodes org_wide for
  cross-dept dedup.
- **Builder wiring** behind `KG_CRM_EDGES` (default OFF), as an independent
  deterministic step alongside link/owner/schema graphs — so it runs regardless of
  the record Tier-B LLM gate (this is P4-8's "else deterministic only" half).
- **Salesforce wired:** opportunities (owner + account), contacts (owner +
  account), accounts (owner only — the record IS the account, no self-referential
  TIED_TO_ACCOUNT). SF cases are `work_item` shape (P2 owner-graph territory), not
  here.
- **Deferred (documented):** HubSpot owner→OWNS needs `hubspot_owner_id`→name
  resolution (owner is an opaque id, not a name) + the associations API for
  company→TIED_TO_ACCOUNT. Tracked as a follow-up; the mechanism + helper are
  HubSpot-ready (pass `ownerName`/`ownerAccountId`/`accountName` once resolved).
- **Tests:** `structured-records.test.ts` (8) — emission helper (owner/email/id/
  account, blank-omit), opportunity owner+account edges EXTRACTED/1.0, account
  record owner-only (no self TIED_TO_ACCOUNT), visibility split, empty cases,
  non-OWNS relations ignored. Fixed `builder-tabular-tier-c.test.ts` flag mock to
  export `KG_CRM_EDGES`. Full suite 970; tsc + RLS clean.

### P4-8: record Tier-B gate — verified + chained-path coverage (2026-06-14)

- **Already implemented** by the P1 gap-closure: `extractionTier('record')` gates
  on longest-LINE > 200 chars (not whole-record length, which over-promoted every
  CRM/calendar record). Free-text descriptions surface as long single lines; field
  lines stay short — so the gate fires exactly when a record carries a meaningful
  description. `extractionTierChained` delegates to `extractionTier` for all
  non-thread shapes, so the indexer path is identical.
- **Verification done here:** added two `extraction-tier-chained.test.ts` cases
  proving the record gate is reachable through the chained entry the indexer uses
  — `>200`-char description → A, short field-only record → B, neither touching
  GLiNER. (Direct `extractionTier` record cases already existed.)
- **"else deterministic only" half:** a Tier-B (un-promoted) record still gets its
  deterministic CRM/calendar field edges — those run as an independent builder step
  (P4-7), exactly like `buildStructuredLinkGraph`/`buildStructuredOwnerGraph`, not
  gated on the LLM decision. So "deterministic only" is structurally delivered by
  P4-7; this ticket owns the LLM gate.
- 40 tier tests green; tsc clean.

### P4-3: PII masking + wide-table column grouping (2026-06-14)

- **PII masking** (`maskPII`, behind `TABULAR_PII_MASKING`, default OFF): masks
  email / SSN / phone tokens → `***` in rendered raw cell values. Applied to (a)
  sample-chunk row renderings and (b) stats-chunk categorical top-values (also raw
  values — leaving them would defeat the feature). Numeric/structural stats
  (counts, ranges, distinct) are untouched, so "stats unaffected" holds for the
  aggregates. Default OFF because it changes embedded content (flags-default-off
  discipline); an org opts in.
- **Wide tables** (> `WIDE_TABLE_COLUMN_GROUP` = 30 cols): each sample row is
  segmented into 30-column groups, each prefixed with a
  `[{table} cols a-b] …` header (table-name + column-range re-emit) so every group
  is self-describing. Narrow tables (≤30) render unchanged (back-compat chunk_id +
  content).
- **Scope decision:** kept as **in-chunk grouping** (one sample chunk with grouped
  sections) rather than physical multi-chunk splitting. Rationale: `buildSampleChunk`
  is called by 4 sites and mocked by 3 warehouse fetcher tests — changing its return
  type to `FetchedChunk[]` would ripple widely; and the P1 chunk-policy engine
  already splits oversized tabular chunks at index time. The header-re-emit keeps
  groups coherent. Physical per-group chunks tracked as a deferred follow-up
  (gate-neutral — not in the P4 gate criteria).
- **Tests:** `tabular-pii-wide.test.ts` (6) — maskPII email/SSN/phone (incl.
  parenthesized + dashed forms), non-PII untouched, multi-token; sample-chunk
  masking applied; wide-table 65-col → 3 group headers, all columns present;
  narrow-table back-compat. Fixed `binary-parsing.test.ts` feature-flags mock to
  export `TABULAR_PII_MASKING` (bi-chunking now imports it). Full suite 960; tsc +
  RLS clean.

### P4-1: D2 — deterministic Tier-C schema entities for tabular docs (2026-06-14)

- **Root cause (audit D2):** `extractSchemaEntities` (the deterministic, no-LLM KG
  path for tables) had ZERO call sites — only a re-export in `extractor.ts`. Tabular
  docs either got skipped (no graph nodes at all) or, pre-shape-routing, ran the LLM
  entity/relation prompt over statistical text (noise).
- **Fix:** `TABULAR_TIER_C` flag (default OFF). When on, the builder treats a doc
  whose chunks are ALL deterministic tabular chunks (`table_stats`/`table_sample`/
  `table_aggregations`, via new `TABULAR_RESOURCE_TYPES`) as Tier C: it **skips the
  LLM extractor entirely** and runs `buildSchemaEntityGraph` instead → table = service
  node, numeric cols = metric concepts (FEEDS), categorical cols = dimension concepts
  (PART_OF), all EXTRACTED/1.0, zero LLM calls.
- **Schema plumbing:** `buildStatsChunk` now emits the structured column schema
  (`schema: [{name,type}]`) in stats-chunk metadata (small, structured — not content;
  passes the chunk-text gate). `buildSchemaEntityGraph` reconstructs a minimal
  `TableStats` (`extractSchemaEntities` only reads `rowCount` + `schema`) and calls
  the existing function. Covers ALL tabular sources (warehouses + uploads + Drive XLSX
  + Sheets) since they share `buildStatsChunk`.
- **Builder wiring** mirrors `buildStructuredLinkGraph`/`buildStructuredOwnerGraph`:
  a pure deterministic producer merged alongside (idempotent via node/edge dedup, so
  safe even on mixed docs). The LLM-skip is gated on the doc being *fully* tabular, so
  a mixed doc still gets LLM on its narrative chunks.
- **Scope note:** the playbook listed "bi_artifact deterministic service/metric nodes
  from artifact names" under this item — folded into **P4-5** (bi_artifact split) where
  the artifact shape/naming lives. P4-1 delivers the tabular schema path (the D2 core).
- **Tests:** `schema-entity-graph.test.ts` (5) — service/metric/dimension nodes,
  FEEDS/PART_OF edges EXTRACTED/1.0, multi-table, ignores non-stats chunks, malformed
  metadata → empty. `builder-tabular-tier-c.test.ts` (1, gate) — warehouse doc →
  `extractEntitiesAndRelations` NOT called + schema entities persisted via upsertGraph.
  Existing builder suite (9) green with flag dormant; full suite 954; tsc + RLS clean.

### P4-4: type-inference hardening — 95th-percentile rule (2026-06-14)

_First ticket; the clean self-contained opener (like P3-4/P3-3). Order: P4-4 →
P4-1 (D2 keystone) → P4-3 → P4-2 → P4-5 → P4-6/7/8._

- **Root cause:** `inferSchema` used `values.every(isNumeric)` / `every(isDateLike)`
  — a single stray cell (`N/A`, a footnote, a unit suffix) flipped a whole column
  to `varchar`, dropping its numeric/date stats and weakening "metric by dimension"
  retrieval.
- **Fix:** classify by type when ≥95% of non-empty sampled values match
  (`TYPE_INFERENCE_THRESHOLD = 0.95`) via a `fractionMatching` helper. Number-first
  ordering preserved; the date guard still requires `length > 4` (zip/IDs stay
  numeric). `computeStats` already filters `NaN` before computing numeric stats, so
  it's robust to the tolerated ≤5% outliers — no downstream change needed.
- **Small-sample safety:** 95% on a 3-value column needs all 3 (2/3 = 67% < 95%),
  so tiny columns require near-unanimity — conservative, no false numeric/date
  promotion.
- **`inferSchema` exported** for unit testing (was private; no tabular test file
  existed). Mirrors the P3-3 `parseXlsxBufferToTables` pattern.
- **Tests:** `tabular-analysis.test.ts` (8) — clean numeric, 1-stray tolerance
  (49+1), mixed→varchar, small-sample near-unanimity, date threshold boundary
  (90% vs 95.2%), zip/ID stays numeric, empty→varchar, blank-header `col_N`. tsc
  clean; tabular consumers (drive-xlsx, binary-parsing) green.

---

## Gate to P5 (criteria + status)

| Criterion | Status |
|---|---|
| Warehouse fixture: 0 LLM extraction calls, schema entities present | ✅ `builder-tabular-tier-c.test.ts` — tabular doc bypasses the LLM extractor; service/metric/dimension nodes persisted (flag `TABULAR_TIER_C`) |
| "metric by dimension" golden queries hit enriched stats chunks (≥15% on tabular set) | todo (needs Jina keys + pilot — batched with P1–P3 gates) |
| Calendar fixtures produce record-shaped rows + obligation-adjacent retrieval | todo |
| CRM OWNS / TIED_TO_ACCOUNT edges EXTRACTED/1.0 | ✅ `structured-records.test.ts` — Salesforce owner→OWNS + record→TIED_TO_ACCOUNT, EXTRACTED/1.0 (flag `KG_CRM_EDGES`); HubSpot owner-id resolution deferred |

**Rollback:** Tier C behind `TABULAR_TIER_C` flag (off → current LLM-on-everything);
vocabulary lines are additive content (re-index removes); bi_artifact shape split is
fetcher-side (re-index reverts).
