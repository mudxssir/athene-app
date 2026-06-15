# Feature Rollout Runbook — flipping P1–P6 on, safely, one stage at a time

_2026-06-15. The operational sequence for enabling the phased pipeline features
(P1–P6) on top of the legacy app without breaking it. Decisions in force:
**validate on a separate staging Supabase · full re-index acceptable · safe
high-value features first.** P0 is baseline (no flag). P7 (encryption) stays OFF._

## Standing rules (every stage)
1. **Migration before flag.** A flag whose table/column isn't applied will error.
   Apply the phase's migration first, on staging.
2. **Flags are GLOBAL env switches** (`process.env.X === 'true'`), not per-org —
   flipping one affects every org on that deployment, and writes derived data
   (re-embeddings, KG edges, scopes) into that Supabase. Hence: **staging first.**
3. **One stage at a time. Verify before the next.** Don't stack unverified flips.
4. **Rollback = flip the flag off** (every feature degrades to legacy). Derived
   data is additive/derivative; re-index/teardown removes it where noted.
5. Legacy stays the source of truth until a stage's gate passes.

## Levers (how a flag takes effect on existing data)
- **Re-index (re-fetch + re-chunk + re-embed + re-extract):** `POST /api/connections/{id}/sync { force: true }` (clears `sync_cursor`).
- **Re-embed only (paced):** `scripts/migrations/re-embed.ts`.
- **KG re-extraction only:** the `graph-build` worker (batched, re-enqueues).
- **Hierarchy build:** `POST /api/admin/graph/rebuild-scopes` → `scope-backfill` → `scope-summary` workers.
- **Captions:** `caption-drain` cron → `caption` worker.

---

## Stage 0 — Make staging ready (GATE for everything)
**Do:** point the app at the **staging Supabase**; apply **all** migrations through
`20260615000003` (additive/idempotent), including the **pgcrypto BYOK fix**
(`20260615000003_fix_pgcrypto_search_path.sql`). Keep **all flags OFF**.
**Legacy impact:** none — additive schema; unread tables/columns.
**Verify:** chat answers, retrieval, KG/graph, a manual sync all behave exactly as
prod; no `pgp_sym_decrypt` error; BYOK key decrypts.
**Rollback:** n/a (no behavior change).

## Stage 1 — Graph-only features *(no re-embed, cheap, additive)*
**Flags (in order):** `KG_OWNER_GRAPH` → `TABULAR_TIER_C` → `KG_CRM_EDGES`.
**Migrations:** `20260612100000_org_member_identities` (ownership). Tier-C/CRM need
no new table.
**Do:** flip → run `graph-build` (or a `sync {force:true}`) so existing docs gain the
new deterministic edges. No embeddings change.
**Legacy impact / adds:** richer KG only. Ownership → PERSON/`OWNS`/`WORKS_ON`/`BLOCKS`
edges + My Work resolves owners via the identity table (no email-prefix heuristic).
Tier-C → tabular docs get deterministic schema nodes instead of LLM noise/nothing.
CRM → `OWNS`/`TIED_TO_ACCOUNT` edges. Retrieval/answers unchanged; graph is denser.
**Verify:** identity-table owner hits in My Work (0 heuristic-fallback log lines);
service/metric/dimension nodes on a warehouse fixture with **0 LLM** extraction;
CRM edges `EXTRACTED/1.0`.
**Rollback:** flag off (new edges simply stop being produced; existing are harmless).

## Stage 2 — Hierarchy scopes *(high-value, derives from the KG — no source re-embed)*
**Flag:** `HIERARCHY_SCOPES`. **Depends on `KG_OWNER_GRAPH` (Stage 1)** for the
blocker matrix + person scopes.
**Migrations:** `20260615000001_kg_scopes`, `20260615000002_blocker_matrix`.
**Do:** flip → `POST /api/admin/graph/rebuild-scopes` (membership backfill) →
community (`scope-backfill` completion) → `scope-summary` worker. Communities use
**Louvain** (Leiden sidecar deferred).
**Legacy impact / adds:** new `kg_scopes`/summaries tables; briefing/chat can read
`get_scope_summary` (the tool is registered but binding into the live agent flow is
a follow-up). Org/team/dept/person summaries + dept×dept blocker matrix. Adds LLM
summary cost (debounced, `input_hash` skip).
**Verify:** `kg_scopes` populated; summaries generated then skipped on re-run
(input_hash); blocker matrix returns; org summary cites only org-visible content
for a member account (RLS).
**Rollback:** flag off → all readers fall back to live queries; scopes are
derivative (teardown safe).

## Stage 3 — Shape routing + re-embed *(retrieval foundation — needs a full re-index)*
**Flag:** `PIPELINE_SHAPE_ROUTING`.
**Migrations:** `20260611000004_parent_chunk_index`, `20260612000001_embedding_pinning`,
`20260612000002_vector_search_model_filter`, `20260611000002_embedding_provenance`,
`20260611000005_vector_search_parent`.
**Do:** flip → run `re-embed.ts` (paced) + `sync {force:true}` so per-shape chunking,
small-to-big parent/child, and the per-shape embedding hint apply. Mixed old/new
rows stay searchable (model-filtered).
**Legacy impact / adds:** the biggest behavior change — chunking + embedding hint +
extraction tier now key on `data_shape` instead of provider strings. Full benefit
(parent-return, per-shape policy) only after re-index. Old chunks remain valid.
**Verify:** zero `legacy-routing` log lines on the re-indexed connectors; recall@5
vs the P0 baseline (`docs/plans/phase-reports/baselines/p0.json`).
**Rollback:** flag off → P0/legacy routing; old embeddings retained.

## Stage 4 — Sidecar parsing *(infra: deploy athene-parse first)*
**Flag:** `SIDECAR_PARSING`. **Prereq: deploy the Python `athene-parse` sidecar**
(`services/athene-parse/`) and set its URL/signed-token env.
**Migrations:** `20260613000001_p3_parsing_promotion` (external_parsing_allowed,
media_queue).
**Do:** deploy sidecar → flip → re-index binaries (`sync {force:true}`). **Safe even
if the sidecar is down** — the cascade falls back to LlamaParse(opt-in)/TS.
**Legacy impact / adds:** Docling-quality parsing (tables, layout, picture stubs for
P5); `parser_used` stamped. No change when the sidecar is unreachable.
**Verify:** `parser_used=docling` on re-parsed binaries; shadow-diff sane; kill the
sidecar mid-sync → sync completes on fallback (circuit-breaker drill).
**Rollback:** flag off → P1 inline-parser behavior.

## Stage 5 — Context envelope + tabular PII mask + vocab *(content-changing → re-embed + LLM cost)*
**Flags:** `CONTEXT_ENVELOPE`, `TABULAR_PII_MASKING`, `TABULAR_VOCAB_ENRICHMENT`.
**Migrations:** `20260613000002_documents_context_summary`, `20260614000001_tabular_vocab_cache`.
**Do:** flip → re-embed affected docs/tables (these change the **embedded** text;
raw chunk_text/citations are untouched). Watch the per-org enrichment budget.
**Legacy impact / adds:** embeds breadcrumb + doc-context + situating lines →
better retrieval grounding; PII (email/SSN/phone) masked in tabular **sample** chunks
before embedding (stats unaffected); business-vocabulary alias line on stats chunks
for NL "metric by dimension" queries. Adds cheap-tier LLM calls per doc/table (cached).
**Verify:** situating lines present in embedded text; PII masked in sample chunks;
alias line in stats header; recall lift on the prose/tabular golden sets.
**Rollback:** flag off + re-index (additive embedded content; re-index reverts).

## Stage 6 — Media captions *(vision cost)*
**Flag:** `MEDIA_CAPTIONS`. **Migration:** media_queue (already in Stage 4's migration).
**Do:** flip → the `caption-drain` cron drains `media_queue` (Gmail attachments work
today; docling-picture byte-fetch is a documented sidecar follow-up). Per-org daily
budget; overflow deferred, never dropped.
**Legacy impact / adds:** images → `[Image in {breadcrumb}]: {caption}` prose chunks
(new searchable content). Vision-model cost per image. Closes audit D12.
**Verify:** caption chunks indexed; every skip/fail telemetried (sync_skips); budget
defers rather than drops.
**Rollback:** pause (queue accumulates harmlessly); caption chunks deletable by
`resource_type='media_caption'`.

---

## Sequence summary (dependency-ordered)
```
Stage 0 (gate) → Stage 1 (graph-only) → Stage 2 (hierarchy, needs KG_OWNER_GRAPH)
              → Stage 3 (shape routing + re-embed) → Stage 4 (sidecar) → Stage 5 (envelope/PII/vocab) → Stage 6 (captions)
```
Stages 1–2 are the **safe high-value first** set (cheap, no source re-embed,
impressive: ownership graph + team/org summaries + blocker matrix). Stages 3–6 are
the re-index/cost-heavy foundation + enrichments, staged after validation.

## Excluded this rollout
- `CHUNK_TEXT_ENCRYPTION` (P7) — P7 is incomplete; keep OFF.
- `WRITE_ACTIONS_ENABLED` — product is read-only (REFOCUS freeze); unrelated.
