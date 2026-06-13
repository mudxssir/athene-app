# P3 Pilot Enablement Runbook

_Operational playbook for the infra/pilot track to validate and enable P3 (and the
batched P1/P2 gate measurements that share the same infra). The P3 **code** is
done, reviewed, and merged with all feature flags **OFF** — this runbook is the
path from "merged, dormant" to "enabled and measured on a pilot org."_

_Maps to the V1–V7 checklist in `P3_TRACKER.md`. Run on a **staging org first**,
then the pilot. Each step lists the exact command/flag and the abort/rollback._

---

## 0. Preconditions

- A pilot org id (`ORG`) with real connected sources (Drive, Gmail, Outlook,
  SharePoint/OneDrive) and recent sync history.
- Jina embeddings API key configured for the org (`embedding_model_pinned`
  defaults to `jina-embeddings-v3`).
- Staging Supabase project reachable; `SUPABASE_SERVICE_ROLE_KEY` +
  `NEXT_PUBLIC_SUPABASE_URL` in the shell env for the scripts below.
- A host for the `athene-parse` sidecar (Fly.io / Cloud Run, private network).

All P3 flags are **OFF** by default. Enable them one at a time, lowest-blast-radius
first, and measure between each.

---

## V1 — Apply migrations (staging → pilot)

P3 adds two additive migrations (no destructive DDL):
- `20260613000001_p3_parsing_promotion.sql` — `organizations.external_parsing_allowed`, `media_queue` table.
- `20260613000002_documents_context_summary.sql` — `documents.context_summary`.

```bash
# staging first
supabase db push                      # applies pending migrations
npm run check:rls                     # RLS guard must stay green
# verify: media_queue has admin-read RLS, both columns present
```
**Rollback:** both are additive (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
EXISTS`); drop the column/table only if rolling the whole phase back. No data
migration, so re-apply is idempotent.

---

## V2 — Deploy the `athene-parse` sidecar

Image: `services/athene-parse/` (Dockerfile pinned). Bundles Docling, MarkItDown,
Chonkie, GLiNER (P2-10), and Talon (P3-6, `talon==1.4.4`).

```bash
# build + deploy to the private host (example: fly deploy / gcloud run deploy)
# then set on the Next.js app:
SIDECAR_URL=https://athene-parse.internal
SIDECAR_AUTH_TOKEN=<shared-secret>          # required in prod; /healthz exempt
# optional:
GLINER_MODEL=urchade/gliner_small-v2.1      # default
```
**Build-validate before flipping any flag:**
- `python -m pytest services/athene-parse/tests/` green in the built image.
- `GET /healthz` → 200; `POST /parse` on a sample PDF returns `tables[]`/`pictures[]`
  (confirms the Docling `export_to_dataframe` / `prov.page_no` API shapes match —
  the code degrades to `[]` on mismatch, so check a real doc returns non-empty).
- `POST /email/clean` on a quoted email returns a non-empty `quoted_tail`.

**Shadow first (no behavior change):** set `SIDECAR_SHADOW_RATE=0.05` to sample 5%
of parses and log structural-diff vs the inline parser. Review the diffs before V3.

**Rollback:** unset `SIDECAR_URL` → `sidecarAvailable()` is false → all callers
fall back to inline parsers. Circuit breaker also opens after 3 failures (5-min).

---

## V3 — Enable tiered parsing (gate: parser-fallback < 5%/week)

```bash
SIDECAR_PARSING=true            # per pilot org / deployment
```
Trigger a re-sync of the binary connectors (Drive/SharePoint/OneDrive/uploads).
**Measure** over a week from telemetry: the share of chunks stamped
`parser_used='ts-fallback'` must be < 5% (sidecar healthy most of the time).
- Optional per-org LlamaParse lane 2: set `organizations.external_parsing_allowed = true`.

**Rollback:** `SIDECAR_PARSING=false` → P1 inline-parser behavior.

---

## V4 — Enable the context envelope + re-embed (gate: prose recall@5 ≥ 20% over P0)

```bash
CONTEXT_ENVELOPE=true
# re-embed the pilot corpus with the pinned model (paced, resumable):
npx tsx scripts/migrations/re-embed.ts --org $ORG            # --dry-run to preview
# record retrieval metrics and compare to the P0 baseline:
npm run eval:retrieval                                       # writes recall@5 / MRR
```
Compare `prose` recall@5 to `docs/plans/phase-reports/baselines/p0.json`. Gate is
≥ 20% improvement. (Note: `p0.json` was marked stale in P0 — re-record the baseline
on the same scratch fixtures before comparing if needed.)

Watch the enrichment cost: doc-context is 1 simple-tier call/doc; situating is
~0.1 call/chunk (prose/email/work_item, multi-chunk only); cross-doc concurrency
is capped at `ENVELOPE_CONCURRENCY=5`.

**Rollback:** `CONTEXT_ENVELOPE=false` → embeds raw chunk text (breadcrumb-only is
never persisted into chunk_text, so no cleanup needed).

---

## V5 — Email per-slice migration (gate: docs-per-email = 1, dup-text < 2%)

The P3-5 one-chunk-per-email scheme is already live (no flag). To purge the OLD
per-slice rows and re-index cleanly:

```bash
# DRY-RUN is the default — prints counts + sample external_ids, deletes nothing:
npx tsx scripts/migrations/delete-per-slice-emails.ts --org $ORG
# review the count, then on STAGING:
npx tsx scripts/migrations/delete-per-slice-emails.ts --org $ORG --execute
# trigger a mailbox re-sync, then verify:
#   - documents-per-email = 1 (no :idx rows remain)
#   - duplicate-text ratio across email rows < 2% (Talon strips quoted chains)
```
Only after the staging drill passes, run `--execute` on the pilot.

**Rollback:** reversible only by re-index (accepted). The classifier matches ONLY
`^gmail:[^:]+:\d+$` / `^ms_email_[^:]+:\d+$` — it never touches the new one-chunk,
calendar (`:ical:`), or thread-parent (`:thread:`) docs (unit-tested).

---

## V6 — Confirm decision extraction on doc sources (D1 close)

On the pilot, after V3/V4 sync: verify decision nodes appear in the KG from
Drive / Gmail / SharePoint / upload sources (shape routing closed D1 in P1; this
is the live confirmation). Spot-check a known decision-bearing document.

---

## V7 — Confirm media_queue is filling (P5 input)

```sql
select origin, status, count(*) from media_queue where org_id = :org group by 1,2;
```
Expect `pending` rows with `origin in ('docling_picture','gmail_attachment')`
accumulating. P5's caption worker consumes these — no action now beyond confirming
the stubs are written (no silent media drops, audit D12).

---

## Enable order summary

`shadow (V2)` → `SIDECAR_PARSING (V3)` → measure → `external_parsing_allowed`
(opt-in) → `CONTEXT_ENVELOPE (V4)` + re-embed → measure → email purge (V5) →
confirm V6/V7. One flag at a time; measure between each; staging before pilot.
