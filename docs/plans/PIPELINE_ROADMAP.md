# Pipeline Roadmap — Phased Execution of Plans A / B / C

_2026-06-11. One sequence, all connector groups, depth-first per phase (each phase is
finished — code, tests, eval, telemetry — before the next starts). Defect IDs reference
`DATA_PIPELINE_AUDIT_V2.md` §6._

**Cross-phase invariants (apply to every phase):**
- No phase ships without its golden-set retrieval eval and KG fixture tests passing.
- Every silent failure path converted in that phase emits `sync_skips`/`sync_errors` telemetry.
- `PIPELINE_VERSION` bumps + paced re-index accompany any chunking/parsing change.
- All new reads/writes of chunk text go through the encrypt-capable helper (Phase 0) so the
  Phase 7 encryption flip is config, not refactor.
- Rollback story per phase: feature-flagged routing (`shape` vs legacy), sidecar circuit
  breaker, scope rebuild escape hatch.

---

## Phase 0 — Stop the bleeding (audit P0/P1 string patches)  ~days
Small, shippable immediately, independent of everything else:
1. D1: add `google`, `microsoft`, `direct_upload` to `DECISION_SOURCE_TYPES` (interim until
   shape routing).
2. D5: pass `'query'` hint in `vector-search.ts` (both call sites) + `entity-resolver.ts`;
   map to Jina `retrieval.query`.
3. D6 (interim): persist `embedding_model` per row; alert on fallback-chain activation. No
   re-embed yet — just stop being blind.
4. D9: group embedding batches by hint.
5. D11: stop indexing skip-sentinel strings (Microsoft/upload paths); add `sync_skips`.
6. Introduce `lib/indexing/chunk-text-store.ts` — the encrypt-capable helper wrapping all
   chunk_text reads/writes (KG builder, diff agent, indexing) — plaintext mode for now.
**Exit:** eval harness in place (golden sets per shape from pilot-org fixtures); baseline
retrieval metrics recorded — every later phase measures against this.

## Phase 1 — Foundations: `data_shape`, sidecar skeleton, embedding pinning  ~1–2 wks
- `shape` field on FetchedChunk + all ~25 fetcher constructors; shape-routed
  `chunkContent`/`resolveEmbeddingHint`/tier gate/decision gate with legacy fallback +
  telemetry (D1/D3/D10 root fix).
- Sidecar `athene-parse` deployed (healthz, `/parse` Docling lane, `/chunk` Chonkie lane,
  circuit breaker client, fallback contract) — consumed by nothing user-facing yet; shadow
  mode: parse a sample of each sync batch, log quality diff vs current parser.
- Embedding pinning: `embedding_model_pinned` org setting (default jina-v3),
  `needs_embedding` retry queue replaces silent fallback (D6 full fix); re-embed migration
  job written + run on pilot org; search filters by model.
- Dynamic chunk-policy engine (`chunk-policy.ts`) with per-shape budgets; small-to-big
  parent/child columns; late chunking on for prose/email/thread/work_item.
**Exit:** zero legacy-routing log lines on pilot org; re-embedded pilot corpus beats Phase-0
baseline ≥15% recall@5; mixed-model SQL assertion green.

## Phase 2 — Engineering group: Jira / Linear / GitHub / Slack (work_item + thread depth)  ~1–2 wks
- `structured_owners` from all four + identity link table + admin confirm UI; My Work /
  obligations switch off the email-prefix heuristic.
- Org-wide visibility for structured work-graph edges (cross-dept blocker chains — audit §8).
- GitHub issue↔issue refs; Linear project/cycle PART_OF links; ADF unknown-node placeholders;
  Slack stable thread windows (tail-append, no full re-embed), backward history walk,
  per-org bot allow-list; focused blocker/obligation extraction pass (Tier A/B third prompt).
- GLiNER gate upgrade for Slack Tier B (sidecar `/nlp` lane).
**Exit:** blocker-chain fixture crossing two departments visible to a member account; My Work
resolves owners via identity table on pilot; Slack re-embed volume per reply drops >90%.

## Phase 3 — Docs + Email group: Drive / Gmail / Notion / Confluence / SharePoint / OneDrive / uploads (prose + email depth)  ~2 wks
- Sidecar promoted to primary parser lane (Docling; MarkItDown breadth; LlamaParse demoted to
  org-opt-in hosted lane; TS fallback lane retained). D7: Drive XLSX → tabular engine. D8:
  per-shape converters own HTML stripping; global regex deleted.
- Email shape rebuild (D4): one doc per email, Talon quote/signature cleaning, thread
  stitching, calendar-invite routing; per-slice document migration (delete + re-index).
- Context envelope fully on for prose/email/work_item: breadcrumbs (incl. Notion/Confluence
  ancestor chains), cached doc-context lines, batched per-chunk situating lines.
- Decision extraction verified live for Drive/Gmail/SharePoint/uploads (D1 regression suite).
**Exit:** email duplicate-text <2%; decision nodes from all doc sources on fixtures;
prose recall@5 ≥20% over Phase-0 baseline; parser_used=fallback rate <5%.

## Phase 4 — BI + CRM groups: warehouses / BI tools / Salesforce / HubSpot / Zendesk / calendars (tabular + record + bi_artifact depth)  ~1–2 wks
- D2: `extractSchemaEntities` wired into builder; tabular/bi_artifact → Tier C (no LLM);
  vocabulary-enrichment line per table; warehouse column comments into stats chunks;
  column-group splitting for wide tables; PII masking flag for sample chunks.
- bi_artifact shape split from tabular (Looker/Metabase/Tableau/PowerBI/dbt artifact chunks
  vs row samples); fence-atomic chunking for DAX/LookML/dbt SQL.
- Calendars to record shape (D3) with structured_fields + attendee edges (≥2 internal
  attendees rule); CRM `structured_owners` + deterministic field edges (TIED_TO_ACCOUNT,
  OWNS); record field-group splitting for oversized records.
**Exit:** zero LLM extraction calls on warehouse fixtures with schema entities present;
"revenue by region"-style eval queries hit enriched stats chunks; calendar events appear in
My Work-adjacent obligation queries.

## Phase 5 — Media shape: vision captions  ~1 wk
- Caption worker (BYOK vision tier, budget + retry queue, SHA dedupe, decorative-image
  skip, EXIF strip); sources in order: PDF figures (Docling pictures), Notion image blocks,
  Slack/Gmail attachments (revive dead Gmail attachment fetcher), BI chart PNGs (DePlot
  chart→table bench on the side).
**Exit:** image-only PDF fixture answers a content question via caption chunk; skipped-media
telemetry replaces all silent drops (D12 closed).

## Phase 6 — Hierarchy materialization (Plan C, full)  ~2–3 wks
Build order exactly as Plan C §6: schema/RLS/lifecycle → membership maintenance + backfill →
Leiden (graspologic) L1 communities → bottom-up summary workers → person scopes with TTL +
canary → blocker matrix + responsibility ledger + watchlist template. Briefing (§6.3) and
chat tools read scope summaries.
**Exit:** Plan C acceptance list; briefing assembled from summaries on pilot org; dept×dept
blocker matrix <200 ms.

## Phase 7 — Hardening fast-follows  ~1 wk
- chunk_text encryption flip (per-org AES-GCM via existing KMS derivation) + re-encryption
  job + key-rotation runbook.
- Sovereignty lane: TEI + nomic-embed self-host option behind `embedding_model_pinned`.
- License/CI gates (sidecar image scan, license allow-list), SOC-2 evidence capture for the
  sidecar boundary, load test (sidecar throughput ≥ LlamaParse baseline).

---

### Dependency graph (what blocks what)

```
P0 ──→ P1 ──→ P2 ──→ P6
        │      ├──→ P3 ──→ P5
        │      └──→ P4 ──→ P6
        └──→ (re-embed migration gates P3/P4 eval claims)
P7 trails everything; encryption helper from P0 makes it config-only.
```

P2 before P3/P4 because identity + org-wide edges are foundations Plan C needs and the
pilot's daily-use surfaces (My Work) repay depth fastest; P3/P4 can interleave if two
workstreams exist, but each must be completed in depth before its group is declared done.
