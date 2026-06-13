# P4 Tracker — BI + CRM Group Depth (warehouses / BI tools / Salesforce / HubSpot / Zendesk / calendars)

_Sprint-style tracker for Phase 4 of `PHASE_EXECUTION_PLAYBOOK.md`. One row per ticket;
detail blocks below. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p4-bi-crm-depth` (off `pipeline/p3-docs-email-depth`) · Flags: `TABULAR_TIER_C` (default OFF) · Started: 2026-06-13_

## Tabular determinism

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P4-4 | Type-inference hardening: 95th-percentile rule replaces `every()` in `tabular-analysis.ts inferSchema` | done | S | — |
| P4-1 | D2: builder Tier C path — `extractSchemaEntities` for tabular (0 LLM); bi_artifact deterministic service/metric nodes; media inherits parent | todo | M | P4-4 |
| P4-3 | Wide tables: column-group splits (30 cols) + table-name header re-emit; PII masking flag for sample chunks (stats unaffected) | todo | M | P4-4 |
| P4-2 | Vocabulary enrichment: 1 simple-tier call/table → alias line in stats header (cached by schema hash); warehouse column comments | todo | M | P4-1 |

## bi_artifact split

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P4-5 | Looker/Metabase/Tableau/PowerBI/dbt: artifact-metadata → `bi_artifact`; row samples → `tabular`; DAX/LookML/SQL → fence-atomic | todo | M | P4-1 |

## Records

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P4-6 | Calendars → record shape (D3): structured_fields (attendees/organizer/start/end/recurrence); attendee WORKS_ON edges gated ≥2 internal; recurring master+next; declined/cancelled extraction-skipped | todo | M | P2 identity |
| P4-7 | CRM deterministic field edges: SF/HubSpot owner→OWNS (identity), account→TIED_TO_ACCOUNT; oversized field-group split; raw numerics in metadata | todo | M | P2 identity |
| P4-8 | Record Tier B rule: description >200 chars → gated LLM; else deterministic only | todo | S | P4-1 |

---

## Defects closed this phase

| Defect | Title | Closed by |
|--------|-------|-----------|
| D2 | `extractSchemaEntities` dead code — BI tables get LLM noise instead of deterministic schema graph | P4-1 |
| D3 (verify) | Calendars never get record chunking / structured_fields (closed by shape in P1; structured-field + edge depth here) | P4-6 |

---

## Session notes

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
| Warehouse fixture: 0 LLM extraction calls, schema entities present | todo |
| "metric by dimension" golden queries hit enriched stats chunks (≥15% on tabular set) | todo (needs Jina keys + pilot — batched with P1–P3 gates) |
| Calendar fixtures produce record-shaped rows + obligation-adjacent retrieval | todo |
| CRM OWNS / TIED_TO_ACCOUNT edges EXTRACTED/1.0 | todo |

**Rollback:** Tier C behind `TABULAR_TIER_C` flag (off → current LLM-on-everything);
vocabulary lines are additive content (re-index removes); bi_artifact shape split is
fetcher-side (re-index reverts).
