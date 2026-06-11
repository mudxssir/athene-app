# Phase Execution Playbook — Per-Phase Plan, To-Do Lists, Gates & Protocols

_2026-06-11. Operational companion to PLAN_A / PLAN_B / PLAN_C / PIPELINE_ROADMAP. This is
the document a developer (or agent session) executes from. Where Plan A (in-house) and
Plan B (OSS) propose competing approaches, the verdict is recorded here once and is binding._

---

## A-vs-B Verdicts (binding component decisions)

| Component | Plan A offer | Plan B offer | Verdict & rationale |
|---|---|---|---|
| Binary/prose parsing | TS parsers (pdf-parse, mammoth, xlsx) | Docling sidecar, MarkItDown breadth | **B primary, A demoted to fallback lane 3.** Benchmarks are unambiguous on tables/layout; A's parsers already exist so the fallback is free. LlamaParse becomes opt-in lane 2. |
| Chunk policy | TS signal-based policy engine | Chonkie chunkers | **Hybrid, A decides / B executes.** Policy + token math stay in TS (deterministic, testable, no version drift); sidecar `/chunk` executes only the semantic strategy. Structural & recursive splitting implemented in TS (cheap, no network hop). |
| Email cleaning | regex heuristics | Talon | **B primary, A fallback.** Quote/signature detection is a solved problem; don't rebuild it. Cap-strip guard (≤30% body) wraps both. |
| Tier-B extraction gate | regex signal patterns (exists) | GLiNER NER confirm | **A first, B second — chained.** Regex is free and high-recall; GLiNER only runs on regex-positives to cut LLM false-positives. Never B alone (latency per message). |
| Communities | graphology Louvain (exists) | graspologic Leiden | **B for hierarchy levels, A retained for flat-graph pass until parity test, then retired.** Leiden's hierarchical partitions are required by Plan C; Louvain can't produce them. |
| Scope summaries | own prompts | GraphRAG report prompts (MIT) | **B's prompt design, A's runtime.** Fork report prompt + rating schema into `lib/knowledge-graph/prompts/`; execution through existing `resolveModelClient` (BYOK-aware). Never run GraphRAG's pipeline. |
| Embeddings | pinned Jina v3 API | TEI + nomic self-host | **A primary; B is the sovereignty lane** behind the same `embedding_model_pinned` switch. Same code path, different endpoint — build once in Phase 1, light up TEI in Phase 7. |
| Identity resolution | identity table + entity-resolver | Splink linkage | **A for runtime; B only as onboarding backfill job** for orgs with >2k historical actors. Splink output writes *candidates* (confidence < 1) requiring admin confirm — never auto-merges. |
| Vision/media | LLM-factory captions (BYOK) | Moondream/DePlot self-host | **A primary.** B is a cost-triggered bench (2 consecutive months over caption budget → stand up Moondream). DePlot chart→table is a Phase-5 side-bench, promoted only if it beats caption-text retrieval on BI-chart fixtures. |

**Standing SDLC protocol (all phases):**
- One feature branch per phase (`pipeline/p<N>-<slug>`); PRs ≤ ~600 lines reviewed via
  `/code-review`; merge to `main` only with phase gate green. Push to `personal` remote only.
- Every new module ships with unit tests beside it (`__tests__/`); every fetcher change
  updates its existing test file; eval harness runs in CI nightly, not per-PR.
- Feature flags: `PIPELINE_SHAPE_ROUTING`, `SIDECAR_PARSING`, `CONTEXT_ENVELOPE`,
  `HIERARCHY_SCOPES` — all default off in prod until the phase gate, removable two releases
  after full rollout (no permanent flags).
- Queueing standard: every background job is QStash with explicit `retries: 3`, exponential
  backoff, an idempotency key (`org:job:input-hash`), and a dead-letter handler that writes
  `sync_errors` rows visible in the admin sync-health page. No fire-and-forget without a
  `.catch` that records telemetry (event-extractor pattern).
- Data-handling rules: chunk text only via `chunk-text-store.ts`; no content in logs; no new
  service-role reads without the SERVICE-ROLE JUSTIFICATION comment; `scripts/check-rls.mjs`
  must stay green; sidecar receives bytes only over private network and never persists.
- Definition of done per phase = all to-dos checked + gate criteria measured and recorded in
  `docs/plans/phase-reports/P<N>.md` (numbers, not adjectives) + rollback drill executed once.

---

## PHASE 0 — Stop the bleeding

**Scope guard:** string patches and instrumentation only. No routing redesign, no sidecar.

To-do:
1. [ ] `extractor-prompt.ts`: add `google`, `microsoft`, `direct_upload` to
   `DECISION_SOURCE_TYPES` (comment: interim until shape routing, removed in P1).
2. [ ] `vector-search.ts:37,109` + `entity-resolver.ts:129`: pass `'query'` hint;
   `embedding-factory.ts` Jina path: map hint→`task` (`retrieval.query`/`retrieval.passage`).
3. [ ] Migration: `document_embeddings` + `embedding_model text`, `pipeline_version int
   default 1`, `shape text null`; stamp model in both index paths.
4. [ ] `indexing.ts`: group batch texts by resolved hint before `embedBatch` (D9).
5. [ ] Kill sentinel indexing: `microsoft/index.ts`, `upload/route.ts` drop
   `[Unsupported…]` chunks; add `sync_skips(org_id, connection_id, reason, count)` writes.
6. [ ] `lib/indexing/chunk-text-store.ts`: `writeChunkText(meta, text)` /
   `readChunkText(row): string|null` — plaintext passthrough now; refactor `indexing.ts`,
   `builder.ts`, diff-agent reads through it.
7. [ ] Telemetry: log + counter when embedding fallback chain activates (provider != pinned
   intent), when normalizeContent strips >5% of a doc's bytes (D8 exposure metric).
8. [ ] **Eval harness** (`scripts/eval/`): golden query sets per shape from pilot fixtures
   (50 q/shape minimum: prose, email, work_item, thread, tabular); recall@5/MRR runner
   writing JSON baselines to `docs/plans/phase-reports/baselines/`.

Edge protocols: hint grouping must preserve row→embedding alignment (test with mixed
Microsoft batch fixture); sentinel-drop must not break delta sync (document row still
upserted so content_hash dedup keeps working — drop *embedding*, keep doc row with
`metadata.skipped=true`).

**Gate to P1:** baselines recorded; mixed-model rows = 0 new since deploy; decision nodes
appear from a Gmail fixture; all five patches verified by regression tests.
**Rollback:** every item independently revertable; no schema rollback needed (additive).

---

## PHASE 1 — Foundations: shape routing, sidecar skeleton, pinned embeddings, dynamic chunking

To-do — shape routing:
1. [ ] `base.ts`: `DataShape` type + `shape` on `FetchedChunk` (+ `structured_owners?`,
   `context?` placeholders).
2. [ ] All fetcher constructors declare shape (~25 edits; table in PLAN_A Part I is the spec).
3. [ ] `indexing.ts`: `chunkContent(content, shape, signals)` → policy engine;
   `resolveEmbeddingHint(shape)`; legacy provider-string fallback + `legacy-routing` warn log.
4. [ ] `extraction-gate.ts` → `extractionTier(shape, texts)` returning `'A'|'B'|'C'`;
   `extractor.ts` decision-prompt gate on shape ∈ {prose, email, thread}.
5. [ ] Delete is NOT done this phase — string sets remain as fallback until P3 exit.

To-do — chunk policy engine (`lib/indexing/chunk-policy.ts`):
6. [ ] `computeSignals(text): ChunkSignals` (tokens, headingDensity, tableDensity,
   codeFenceRatio, sentenceLen, listRatio) — pure, unit-tested on fixtures per shape.
7. [ ] `selectStrategy(shape, signals): ChunkPlan` per PLAN_A §0.4 table (budgets,
   noSplitCeiling, parent/child, overlap); guardrails minTokens=64, maxChunksPerDoc=400,
   200k-token cap with `[truncated]` marker.
8. [ ] Structural chunker in TS: markdown heading-tree splitter (generalize
   `wiki-fetcher.ts` section logic into `lib/indexing/structural-chunker.ts`), heading-trail
   breadcrumbs returned per chunk; fence-atomic and table-aware modes.
9. [ ] Small-to-big: migration `document_embeddings + parent_chunk_index int null`; child
   embeds, parent text returned at retrieval (`vector.ts` join); fallback to child when no
   parent.
10. [ ] Late chunking: batch children per parent into single Jina call with
    `late_chunking: true` for prose/email/thread/work_item.

To-do — sidecar skeleton (`services/athene-parse/`):
11. [ ] FastAPI scaffold; `/healthz`, `/parse` (Docling primary, MarkItDown fallback inside
    the service), `/chunk` (Chonkie semantic only); Dockerfile (pinned lockfile), deploy
    (Fly/Cloud Run private), signed-token auth middleware.
12. [ ] `lib/integrations/sidecar-client.ts`: typed client, 120 s timeout, circuit breaker
    (3 fails → 5 min open), `parser_used`/`parser_version` stamping, byte-size cap 80 MB.
13. [ ] Shadow mode: sample N docs/sync, parse via sidecar, log structural-diff metrics vs
    inline parser (no user-facing output yet).

To-do — embedding pinning:
14. [ ] `organizations.embedding_model_pinned` (default `jina-embeddings-v3`); factory
    refuses cross-model fallback: on provider failure write rows
    `embedding=null, needs_embedding=true` + enqueue `embed-retry` QStash job (idempotency:
    `org:embed-retry:document_id`); local BGE only when pinned explicitly.
15. [ ] `scripts/migrations/re-embed.ts`: paced re-embed (per-org concurrency 1, batch 96,
    progress checkpoints in a `migration_jobs` row, resumable); run on pilot org.
16. [ ] Search path (`vector.ts`/RPCs): filter `embedding_model = pinned`; CI SQL assertion:
    no org has 2 models among rows with `needs_embedding=false`.

Queueing/data handling: new jobs `embed-retry`, `reindex-pipeline-version`; both DLQ to
`sync_errors`; re-embed job must checkpoint per 1k docs (Vercel timeout safety — re-enqueue
remainder, builder.ts BATCH pattern).

Shape boundaries this phase: routing live for ALL shapes, but *content construction*
unchanged except chunk policy — fetcher content rewrites belong to P2–P4. Document this
explicitly to prevent scope creep.

Edge protocols: legacy fallback logs must reach zero on pilot before gate; chunk-policy
fuzz test (random unicode, 10 MB single-line doc, emoji-only, RTL text, null bytes) may
never throw — worst case returns single truncated chunk; late-chunking batch failure falls
back to per-chunk embedding (same model) transparently; parent/child integrity test: every
child row's parent exists post-prune.

**Gate to P2:** pilot re-embedded corpus ≥15% recall@5 over P0 baseline; zero
legacy-routing lines for pilot connectors; sidecar shadow diff report reviewed; circuit
breaker drill passed (kill sidecar mid-sync → sync completes on fallback).
**Rollback:** `PIPELINE_SHAPE_ROUTING` flag off → P0 behavior; re-embed reversible by model
filter flip (old rows retained until P3 exit).

---## PHASE 2 — Engineering group depth (Jira / Linear / GitHub / Slack)

To-do — identity & ownership:
1. [ ] Migration `org_member_identities` (PLAN_A Part II spec) + RLS (admin write, org
   read) + indexes on (org_id, provider, account_id).
2. [ ] `StructuredOwner` emission: jira (assignee/reporter + accountId), linear (assignee +
   uuid), github (author login; PR requested reviewers as WORKS_ON), zendesk
   (assignee/requester).
3. [ ] Builder step `buildStructuredOwnerGraph()` beside `buildStructuredLinkGraph()`:
   person node resolve via identity table → alias resolver → create-unverified; OWNS /
   WORKS_ON / REPORTED_BY edges EXTRACTED/1.0.
4. [ ] Email-prefix heuristic removed from `my-work.ts` / `my-obligations.ts` → identity
   lookup; admin Users page: identity confirm/merge UI (claims candidates where confidence<1).
5. [ ] Org-wide visibility for structured work-graph edges in `structured-links.ts` (+ the
   new owner edges keep department visibility — ownership is org-readable only via item).
   Verify with RLS test: member A (dept X) sees blocker chain into dept Y items' labels,
   cannot read dept Y document content.

To-do — connector depth:
6. [ ] GitHub: issue↔issue timeline refs → structured_links; issues fetcher emits
   `resource_type: 'issue'`→ work_item shape; PR review comments kept, diffs excluded.
7. [ ] Linear: project/cycle PART_OF links from issues; projects/cycles chunks → work_item.
8. [ ] Jira: ADF unknown-node placeholders (`[media]`, `@mention` resolution via identity
   table); sprint-absence tolerance test.
9. [ ] Slack stable windows: replies become append-only child chunks
   (`slack-msg-{ch}-{ts}:r{n}`, window 10 replies); root doc hash no longer mutates per
   reply; `oldest_indexed_ts` per channel + idle-sync backfill walk; per-org bot allow-list
   in connection metadata; <10-token message skip.
10. [ ] Tier-B chain upgrade: regex (existing) → sidecar GLiNER confirm (`/nlp/gliner`,
    entity types: person/org/project) → LLM. Add obligation/ownership verbs to regex set.
11. [ ] Third extraction pass (blocker/obligation focused prompt) for work_item + gated
    thread chunks; merges via existing node/edge dedup.

Queueing: GLiNER calls batched per document (1 sidecar call per doc, not per chunk);
identity backfill job (Splink bench only if pilot org >2k actors — else skip).

Shape boundaries: only work_item + thread content construction changes; prose/email/record
fetchers untouched (P3/P4).

Edge protocols: blocker cycles fixture (A↔B) — BFS depth caps verified; person with two
provider accounts → identity merge produces single node (test); deleted Slack message →
window re-fetch tombstones the child chunk (prune path); Linear/Jira webhook-less deletes
→ stale items expire via status metadata at query time, full reconcile weekly job.

**Gate to P3:** cross-dept blocker fixture passes as member; My Work owner resolution =
identity table (0 heuristic hits in logs); Slack re-embed volume/reply ↓ >90% (measured);
work_item golden set ≥10% recall improvement; KG fixture: OWNS edges EXTRACTED/1.0 from all
four connectors.
**Rollback:** owner-graph step behind flag; Slack windowing keyed on new chunk_id scheme —
revert = re-index channel (bounded).

---

## PHASE 3 — Docs + Email group depth (Drive / Gmail / Notion / Confluence / SharePoint / OneDrive / uploads)

To-do — parsing promotion:
1. [ ] Route Drive/OneDrive/SharePoint/upload binaries: sidecar `/parse` lane 1 → LlamaParse
   lane 2 (org opt-in flag `external_parsing_allowed`) → TS lane 3; `parser_used` stamped.
2. [ ] Docling output adapter: markdown + heading tree → structural chunker; tables →
   `tabularChunksFromParsed`; pictures → media queue stubs (P5 consumes).
3. [ ] D7: Drive `.xlsx` joins `fetchSheetChunks`-style tabular path; remove
   `extractXlsxText` from the indexing flow (keep as lane-3 fallback emitting ParsedTable).
4. [ ] D8: delete global HTML-strip from `normalizeContent`; per-shape converters own
   sanitization (Confluence/Zendesk/Outlook already strip; add Gmail HTML-part strip).
   Regression: SQL/code fixture survives byte-identical.

To-do — email rebuild (D4):
5. [ ] Gmail + Outlook fetchers emit ONE chunk per email (full body, canonical header
   block); `chunk_id` without `:idx`; Outlook adds `conversationId` as thread_id.
6. [ ] Sidecar `/email/clean` (Talon): reply text embedded; quoted tail + signature stored
   as final non-embedded chunk (chunk-text-store, `embedding=null, skip_embedding=true`).
7. [ ] Migration: delete per-slice documents (`external_id LIKE 'gmail:%:%'` /
   `'ms_email_%:%'`) per org, re-index mailboxes paced; verify citation links survive.
8. [ ] Thread parent rows: synthetic parent per thread_id for small-to-big return + thread
   doc-context line cached, refreshed on new message.
9. [ ] `text/calendar` parts → record shape routing; attachments → media queue stub.

To-do — context envelope:
10. [ ] `documents.context_summary text` migration; doc-context generator (simple tier,
    cached by content_hash, prompt-injection delimiters, ≤60 tok clamp).
11. [ ] Breadcrumb builders per connector: Drive folder_path (exists), Notion ancestor
    chain (parent walk + cache table), Confluence space+ancestors, SharePoint site/drive.
12. [ ] Per-chunk situating lines: batched 10/call JSON, prose/email/work_item, skip
    single-chunk docs; `context_header` stored in embedding-row metadata (separate key from
    chunk_text).
13. [ ] Embed text assembly: `header + '\n\n' + child` (one place: indexing pipeline).

Queueing: `context-enrich` job decoupled from indexing (index first with breadcrumb-only,
enrich + re-embed within the same sync run; if enrichment dies, breadcrumb-only rows are
already searchable). Caption/media stubs accumulate in `media_queue` table for P5.

Shape boundaries: prose + email content construction final; thread/work_item gain envelope
only (no construction change); record/tabular untouched.

Edge protocols: password-protected/corrupt files → lane cascade then skip + surfaced
warning; image-only PDF → OCR in Docling, gibberish guard (alpha ratio <40% → treat as
image-only, media queue); 200-message thread window + summary line; Notion ancestor-walk
cycle guard (depth 10 exists — apply to parents); enrichment cost breaker: per-org daily
budget, overflow = breadcrumb-only (never blocks).

**Gate to P4:** decision nodes from Drive/Gmail/SharePoint/upload fixtures (D1 closed by
shape, string sets deleted now); email dup-text <2%; documents-per-email = 1; prose
recall@5 ≥20% over P0; parser fallback rate <5% over a week; D8 regression green.
**Rollback:** lane flags per connector; email migration reversible only by re-index
(accepted — drill on staging org first).

---

## PHASE 4 — BI + CRM group depth (warehouses / BI tools / Salesforce / HubSpot / Zendesk / calendars)

To-do — tabular determinism:
1. [ ] D2: builder Tier C path — `extractSchemaEntities` for tabular docs (stats chunk
   present), zero LLM calls; bi_artifact deterministic `service`/`metric` nodes from
   artifact names; media inherits parent extraction.
2. [ ] Vocabulary enrichment: 1 simple-tier call/table → alias line in stats chunk header
   (cached by schema hash); warehouse column comments (information_schema) included.
3. [ ] Wide tables: column-group splits (30 cols) with table-name header re-emit; PII
   masking flag for sample chunks (email/ssn/phone regex → `***`, stats unaffected).
4. [ ] Type-inference hardening: 95th-percentile rule replaces `every()` in
   `tabular-analysis.ts` `inferSchema`.

To-do — bi_artifact split:
5. [ ] Looker/Metabase/Tableau/PowerBI/dbt: artifact-metadata chunks → `bi_artifact` shape;
   row samples → `tabular`; DAX/LookML/SQL → fence-atomic chunking.

To-do — records:
6. [ ] Calendars → record shape (D3): structured treatment + structured_fields (attendees,
   organizer, start/end, recurrence); attendee WORKS_ON edges gated ≥2 internal attendees
   (identity table check); recurring events: master + next instance only; declined/cancelled
   indexed, extraction-skipped.
7. [ ] CRM deterministic field edges: SF/HubSpot owner → OWNS (identity), account →
   TIED_TO_ACCOUNT; oversized records field-group split (never mid-field); raw numerics in
   metadata, humanized in content (exists — verify both fetcher families).
8. [ ] Record Tier B rule: description >200 chars → gated LLM; else deterministic only.

Shape boundaries: tabular/bi_artifact/record final; this completes content construction for
every existing connector.

Edge protocols: all-numeric tables (agg skip exists — test); empty tables stats-only;
1000-col table fixture under split rule; currency/locale round-trip; Tableau
view-parameter failures stay non-fatal with telemetry; calendar timezone normalization
(store UTC + original tz in metadata).

**Gate to P5:** warehouse fixture: 0 LLM extraction calls, schema entities present;
"metric by dimension" golden queries hit enriched stats chunks (≥15% improvement on
tabular set); calendar fixtures produce record-shaped rows + obligation-adjacent retrieval;
CRM OWNS/TIED_TO_ACCOUNT edges EXTRACTED/1.0.
**Rollback:** Tier C behind flag (falls back to current LLM-on-everything); vocabulary
lines are additive content (re-index removes).

---

## PHASE 5 — Media shape (vision captions)

To-do:
1. [ ] `media_queue(org_id, source_doc_id, sha256, origin, bytes_ref, status, attempts)` —
   populated since P3 (Docling pictures, Notion image blocks) + new: Slack files, Gmail
   attachments (revive `fetchGmailAttachment`), Drive/OneDrive standalone images.
2. [ ] Caption worker (QStash, batch 10): SHA dedupe (org-wide repeated-logo skip), <10 KB
   decorative skip, EXIF strip, vision call via `resolveModelClient` vision tier with
   shape-specific prompts (chart/diagram/photo), output → prose chunk
   `[Image in {breadcrumb}]: {caption}` linked to parent doc.
3. [ ] Budget: per-org daily caption cap; overflow stays queued (status `deferred`), never
   dropped; admin sync-health shows queue depth.
4. [ ] DePlot side-bench on BI chart PNG fixtures (chart→table→tabular engine) — promote
   only if it beats caption retrieval; otherwise record results and close.
5. [ ] D12 closure: every skip path (decorative, failed, deferred) → `sync_skips` with
   reason; placeholder chunk `[image: caption unavailable]` on terminal failure.

Edge protocols: vision-model refusal/empty caption → 2 retries then placeholder; oversized
images downscaled before send (max 2048px); animated/video formats skipped with reason;
caption hallucination guard — captions prefixed `[Image in …]` so retrieval consumers know
provenance class; private-channel Slack files inherit source visibility.

**Gate to P6:** image-only PDF fixture answers via caption chunk; queue drains on pilot
within budget; zero silent media drops (telemetry audit).
**Rollback:** worker pause = queue accumulates harmlessly; caption chunks deletable by
`resource_type='media_caption'`.

---

## PHASE 6 — Hierarchy materialization (Plan C)

Execute PLAN_C §6 order; to-do summary with protocols:
1. [ ] Migrations: `kg_scopes`, `kg_scope_members`, `kg_scope_summaries` + RLS + dept/org
   lifecycle triggers; `check-rls.mjs` extended to the new tables.
2. [ ] Membership maintenance step in `builder.ts` (touched-nodes only) + full backfill job
   (paced, resumable, per-org); scope `stats` upkeep.
3. [ ] Sidecar `/graph/leiden` (graspologic); L1 communities per app scope; Louvain parity
   test (same fixture, compare modularity + briefing output) → retire Louvain.
4. [ ] Summary workers bottom-up with 15-min debounce, `input_hash` skip, visibility-class
   inputs (dept scopes see dept-visible members only), GraphRAG-derived prompt + highlights
   schema; `get_scope_summary` tool for chat/briefing.
5. [ ] Person scopes: activation triggers (login, sync-touch), 7-day `stale_after` sweep
   (delete rows, status `stale`), live-BFS fallback + background rematerialize, nightly
   canary (N=20 random active scopes, drift alert).
6. [ ] Blocker matrix view (recursive CTE, depth 6, cycle guard) + responsibility ledger +
   unowned-blocker surfacing; admin surface + watchlist template ("my team blocked by other
   dept").
7. [ ] Briefing §6.3 and chat read scope summaries first; rebuild escape hatch endpoint;
   runs automatically post `PIPELINE_VERSION` migrations.

Queueing: `scope-refresh` (debounced, idempotency `org:scope:input_hash`),
`scope-summary`, `person-scope-sweep` (cron daily), `scope-backfill`. All DLQ-visible.

Edge protocols: app disconnect → 30-day grace teardown (test reconnect path); member exit
→ immediate person-scope teardown, `former_member` edge annotation; multi-dept person →
identity-table dept authoritative; summary regeneration storm guard (max 1/scope/window);
unverified-entity quarantine excluded from summaries; org delete cascade verified in
offboarding runbook.

**Gate to P7:** PLAN_C acceptance list in full (idempotent rebuild, canary drift 0 on
fixtures, RLS member test on org summary, briefing reads summaries, matrix <200 ms).
**Rollback:** `HIERARCHY_SCOPES` flag off → all readers fall back to live queries; scopes
are derivative — full teardown is always safe.

---

## PHASE 7 — Hardening fast-follows

To-do:
1. [ ] Encryption flip: `chunk-text-store` AES-GCM per-org (KMS derivation as BYOK);
   re-encryption job (paced, resumable); `content_preview` dropped or encrypted; key-rotation
   runbook + drill; readers (builder, diff-agent, small-to-big return, scope summarizer
   inputs) verified under encryption in staging before prod.
2. [ ] Sovereignty lane: TEI + nomic-embed deploy recipe; `embedding_model_pinned`
   switch + re-embed path tested org-end-to-end; prefix task mapping
   (`search_document:`/`search_query:`).
3. [ ] CI: license allow-list scanner on sidecar image; image vulnerability scan; sidecar
   load test ≥ LlamaParse-baseline throughput; SOC-2 evidence: sidecar network policy, no-
   persistence attestation, pen-test ticket.
4. [ ] Flag cleanup: remove P1–P6 flags fully rolled out ≥2 releases; delete legacy
   provider-string sets' dead remnants; close audit defect register D1–D12 with links to
   closing PRs in `DATA_PIPELINE_AUDIT_V2.md`.

**Gate (program exit):** encryption on for pilot org with all features green; defect
register fully closed; eval suite shows cumulative ≥25% recall@5 over P0 baseline across
shapes; runbooks (key rotation, scope rebuild, re-embed, sidecar outage) exercised once.

---

## Standing edge-case registry (checked at every phase gate)

| Class | Protocol |
|---|---|
| Oversized input (doc >200k tok, file >80 MB, table >1000 cols) | cap + marker + telemetry, never throw |
| Empty/garbage input (0 tokens, gibberish OCR, null bytes) | skip with reason; gibberish = alpha-ratio guard |
| Partial batch failure (embedding, extraction, parse) | per-item isolation; failed items → retry queue; never poison the batch |
| Idempotency (re-run any job) | content_hash + input_hash + idempotency keys; re-runs are no-ops |
| Tenant isolation | RLS tests per new table/path; sidecar carries org_id only as opaque routing, never mixes org payloads in one request |
| Untrusted content → LLM | delimiter pattern + output clamps on every enrichment/summary/caption prompt |
| Provider outage (LLM, embedding, sidecar, source API) | circuit breakers + queue-don't-drop + degraded-mode stamps in metadata |
| Schema/version drift | parser_version, pipeline_version, prompt_version stamped; mismatches trigger re-process, never silent reinterpretation |
| Deletion semantics (source deletes, disconnects, member exit, org offboard) | explicit per-phase teardown paths; grace windows documented |
