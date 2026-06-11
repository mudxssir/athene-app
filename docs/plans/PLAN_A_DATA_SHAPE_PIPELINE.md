# PLAN A — In-House Data-Shape Pipeline: Best Context per Chunk, per Connector

_2026-06-11. Companion to `docs/DATA_PIPELINE_AUDIT_V2.md` (defect register D1–D12 referenced
throughout), `PLAN_B_OSS_MODULES.md` (the parsing/chunking modules this plan consumes), and
`PLAN_C_KG_HIERARCHY.md` (the graph layers built on top of Part II)._

**Locked decisions** (from planning Q&A): Python parsing sidecar · chunk_text stays persisted
(all reads/writes through an encrypt-capable helper; encryption is a fast-follow) · index-time
budget is **quality-first** (LLM enrichment allowed across shapes) · images become vision→text
captions in the existing 768-dim space · embeddings pinned to **Jina v3** per org with model
recorded per row and a re-embed migration · hierarchy is materialized (Plan C).

---

## 0. Foundations (prerequisites for every shape)

### 0.1 The `data_shape` contract

```ts
// lib/integrations/base.ts
export type DataShape =
  | 'prose'        // documents, wiki, pages, articles
  | 'email'        // one message = one unit
  | 'thread'       // chat conversations
  | 'work_item'    // tickets, issues, PRs
  | 'record'       // CRM rows, calendar events — key-value units
  | 'tabular'      // datasets: warehouse tables, sheets, parsed tables
  | 'bi_artifact'  // reports, dashboards, measures, model definitions
  | 'media'        // images/diagrams → captioned text
  | 'code'         // reserved, Phase 2+

export interface FetchedChunk {
  chunk_id: string
  title: string
  content: string
  source_url: string
  shape: DataShape                       // REQUIRED — fetcher declares it
  structured_links?: StructuredLink[]    // promoted from metadata (work_item)
  structured_owners?: StructuredOwner[]  // NEW — deterministic responsibility
  context?: ChunkContext                 // NEW — see 0.3
  metadata: { provider: string; resource_type: string; [k: string]: unknown }
}

export interface StructuredOwner {
  person_label: string          // display name as the source shows it
  provider_account_id?: string  // Jira accountId / Linear UUID / GitHub login / Slack uid
  relation: 'OWNS' | 'WORKS_ON' | 'REPORTED_BY' | 'DECIDED_BY'
}
```

Every routing decision downstream (chunker, embedding task, extraction tier, decision prompt,
structured extraction) switches on `shape`. The five provider-string sets in `indexing.ts`,
`extraction-gate.ts`, `extractor-prompt.ts` are deleted after migration (fixes D1, D3, D10).
Migration safety: `chunkContent()` keeps the legacy provider-string lookup as fallback when
`shape` is absent, logs `[indexing] legacy-routing` with the provider so unmigrated fetchers
are visible in telemetry, and the fallback is removed one release later.

### 0.2 Versioned, re-runnable indexing

New columns on `document_embeddings`: `embedding_model text`, `pipeline_version int`,
`shape text`. New org-level setting `embedding_model_pinned` (default `jina-embeddings-v3`).
Rules:

- Search filters to `embedding_model = pinned` — mixed spaces become impossible (fixes D6).
- Provider failure **never falls through to a different model**. The batch is written with
  `embedding = NULL, needs_embedding = true` and a QStash retry job re-embeds with the pinned
  model. Local BGE remains only as an explicit org-level opt-in (`embedding_model_pinned =
  'bge-base-local'`), not a silent fallback.
- Any change to a shape's chunking policy bumps `PIPELINE_VERSION`; a backfill worker
  re-chunks + re-embeds documents where `pipeline_version < current`, paced per org. Chunk
  pruning already handles shrinkage (`indexing.ts` phase 5); growth is handled by upsert.

### 0.3 Context envelope — the "best possible context per chunk" mechanism

Every chunk is embedded as `contextHeader + '\n\n' + chunkText`, while `chunk_text` stored for
KG/citations remains the raw chunk (header kept in a separate metadata key so it is never
double-counted in citations). The header has three layers:

1. **Deterministic breadcrumb** (free): source kind + container path + title + section trail —
   `Google Drive › /Legal/Contracts › "MSA Acme 2026" › §4 Indemnification`. Built from data
   every fetcher already has (`folder_path`, heading trail, channel name, project key…).
2. **Document context line** (1 cheap-LLM call per *document*, cached by content_hash):
   ≤60-token summary of what the whole document is — Anthropic contextual-retrieval style.
   Generated once via `resolveModelClient('simple', orgId)`, stored on the `documents` row
   (`context_summary` column), prepended to every chunk of that document.
3. **Per-chunk situating line** (quality-first budget; shapes `prose`, `email`, `work_item`
   only): "this chunk covers X within Y" — one `simple`-tier call per chunk, batched 10
   chunks/call with JSON output to keep cost ~0.1 call/chunk. Skipped when the document has
   only one chunk (the majority of records/threads/work items — no cost there).

Failure handling: any enrichment failure degrades to the deterministic breadcrumb — never
blocks indexing. Enrichment calls carry a prompt-injection guard: document text is delimited
and the system prompt instructs the model to ignore instructions inside it; outputs are
length-clamped (≤80 tokens) and stripped of URLs.

### 0.4 Dynamic chunk sizing — the policy engine

Research basis: structure-aware splitting beats fixed windows; semantic chunking adds the
largest accuracy lift on unstructured prose but is ~14× slower than token chunking; late
chunking and contextual retrieval beat overlap tuning; 512/10–20% overlap is the sane default
to deviate *from*. The engine (`lib/indexing/chunk-policy.ts`) computes per-document signals
and picks a strategy — no fixed family sizes anymore:

```
signals = {
  tokens          — total document tokens
  headingDensity  — markdown headings per 1k tokens
  tableDensity    — pipe-table / CSV-line ratio
  codeFenceRatio  — fenced-block tokens / total
  sentenceLen     — mean sentence length (proxy for prose vs logs)
  listRatio       — list-item lines / total lines
}

strategy selection (per shape, then per signals):
  tokens ≤ shape.noSplitCeiling          → single chunk (whole unit)
  headingDensity high                    → structural: split on heading tree,
                                           never inside a section < minTokens,
                                           breadcrumb = heading trail
  tableDensity high                      → table-aware: never split a table row-block;
                                           re-emit header row per split (tabular engine)
  codeFenceRatio high                    → fence-atomic: fences are unsplittable tokens
  else (flowing prose, > maxTokens)      → semantic: embedding-drift breakpoints
                                           (sidecar /chunk, Chonkie SemanticChunker),
                                           fallback recursive sentence splitter
```

Per-shape budgets (child = embedded unit; parent = retrieval return unit — small-to-big):

| shape | noSplitCeiling | child target | parent target | overlap |
|---|---|---|---|---|
| prose | 600 tok | 320 tok | 1200 tok | 0 (structural) / 15% (semantic) |
| email | 800 tok | 512 tok | whole email | 10% |
| thread | 600 tok | 512 tok | whole thread window | 15% |
| work_item | 800 tok | 512 tok | whole item | 10% |
| record | whole record (≤3000 chars, else field-group split — never mid-field) | — | — | 0 |
| tabular | whole stats/agg chunk ≤1200 tok | 768 tok table-aware | per-table | header re-emit |
| bi_artifact | whole artifact ≤800 tok | 512 | — | 0 |
| media | whole caption | — | — | 0 |

**Small-to-big:** embeddings are computed on child chunks (precision), but each row stores
`parent_chunk_index`; retrieval returns the parent text from `chunk_text` of the parent row.
This is exactly what persisted `chunk_text` buys us and costs no extra embedding calls.

Edge cases: empty/whitespace docs → skip with telemetry; single-sentence docs → single chunk;
docs > 200k tokens → cap at 200k with `[truncated]` marker + warning metric; tokenizer
failures (invalid UTF-8) → byte-sanitize then re-tokenize; semantic chunker timeout (>10 s/doc)
→ fall back to structural/recursive; degenerate semantic output (1 giant or 500 tiny chunks)
→ guardrails minTokens=64 / maxChunksPerDoc=400 force recursive fallback.

---

## PART I — Vector Embeddings, per shape × connector

**Global spec:** Jina v3 pinned; `task: 'retrieval.passage'` at index, `'retrieval.query'` at
search (fixes D5 — also fixes today's hardcoded passage task for queries); `late_chunking:
true` for shapes prose/email/thread/work_item (children of one parent submitted in one API
call so each child's vector is conditioned on the full parent context — this is the highest
quality-per-dollar upgrade available, zero extra calls); `dimensions: 768` (Matryoshka);
batch 96; per-row `embedding_model` stamp.

### Shape: prose — Drive (Docs/Slides/PDF/DOCX narrative), OneDrive/SharePoint, Notion, Confluence, GitHub wiki, Zendesk articles, uploads
- Conversion: sidecar (Plan B) returns markdown with heading tree + provenance; Notion/
  Confluence converters keep emitting markdown directly (already good).
- Chunking: structural-first via heading tree (the GitHub wiki splitter generalizes —
  `wiki-fetcher.ts:114` is the in-house prototype); semantic for heading-poor prose.
- Context: breadcrumb = `source › folder_path/space › title › H1 › H2…`; doc-context line; per-chunk
  situating line. Per-connector breadcrumb sources: Drive `folder_path` (already in metadata),
  Notion parent-page chain (fetch `parent` ids — one extra call per page, cache), Confluence
  space + ancestors, SharePoint site/drive names.
- Embedding: passage + late chunking over parent windows.
- Fixes folded in: D8 (`normalizeContent` must skip fenced blocks — move HTML-stripping into
  the per-shape converter, where ADF/HTML sources are already stripped, and delete the global
  regex); D11 (skip-sentinels are dropped, never indexed, counted in `sync_skips` telemetry).
- Edge cases: image-only PDFs → OCR path (Plan B) else `media` placeholder chunk with caption
  queue; mixed-language docs → no special handling v1, language stamped in metadata for future
  filtering; password-protected files → skip + per-sync surfaced warning (today: silent).

### Shape: email — Gmail, Outlook
- **One FetchedChunk per email** (fixes D4): fetchers stop pre-slicing; full body + canonical
  header block (`From/To/Cc/Subject/Date`) as content; `chunk_id = gmail:{id}` /
  `ms_email_{id}`. Existing per-slice documents are deleted by external-id prefix migration.
- Pre-processing: quote/signature stripping (Plan B: Talon) so replies don't re-embed the
  entire quoted chain — the single largest noise source in email corpora. Keep the stripped
  tail in `chunk_text` of a dedicated final chunk (provenance) but exclude it from embedding.
- Thread stitching: `thread_id` already captured (Gmail) — add Outlook `conversationId`.
  Embedding stays per-message; the *KG and parent-return unit* is the thread (parent pointer
  to a synthetic thread parent row).
- Context: breadcrumb = `Email › {mailbox} › thread subject`; doc-context line = one-line
  "what this thread is about" cached per thread, refreshed when a new message arrives.
- Edge cases: HTML-only bodies (Outlook strip exists; Gmail `extractBodyFromPayload` must
  prefer text/plain part, fall back to stripped text/html); calendar invites inside email
  (`text/calendar` part) → route to `record` shape; attachments → enqueue to media/binary
  pipeline (Gmail fetcher exists at `gmail-fetcher.ts:169`, currently dead — D12); huge
  threads (>200 messages) → window to last 50 + summary-of-earlier line.

### Shape: thread — Slack (later Teams)
- Unit stays one root message + replies, but with **stable windows**: a thread re-chunks only
  its *tail* — replies are appended as new child chunks (`slack-msg-{ch}-{ts}:r{n}` windows of
  ~10 replies) instead of mutating one document's hash (kills the full re-embed churn per
  reply).
- Context: breadcrumb = `Slack › #channel › thread started {date} by {author}`; speaker turns
  prefixed `@name:`; doc-context line per thread (cheap, cached).
- Embedding: passage + late chunking across the thread window (pronoun-heavy chat is exactly
  what late chunking exists for).
- Edge cases: 30-day fetch horizon leaves orphan tails → store `oldest_indexed_ts` per channel
  and walk backward on idle syncs; edited/deleted messages → Slack `edited.ts` triggers
  re-index of that window only; bot allow-list (some bots ARE signal: GitHub/Linear unfurls)
  → keep drop-by-default, add per-org allow-list config; emoji-only / <10-token messages →
  skip embedding, keep in thread text.

### Shape: work_item — Jira, Linear, GitHub issues/PRs, Zendesk tickets
- Content layout (already good) becomes a fixed template so embeddings are structurally
  comparable across trackers: header fields block → description → last-N comments with
  authors. Comments beyond the window roll into "earlier discussion" summary line
  (quality-first budget).
- `structured_owners` emitted by all four (assignee/reporter/author + provider account ids);
  `structured_links` extended: GitHub issue↔issue refs from timeline events; Linear
  project/cycle containment links (`PART_OF`).
- Context: breadcrumb = `Jira › PROJ › PROJ-123 [status]`; status/priority kept in both
  content header and metadata (faceting).
- Embedding: passage + late chunking (description + comments are context-dependent).
- Edge cases: ADF nodes unknown to `adf-to-text` (panels, media, mentions) → explicit
  placeholder `[media]` / `@name` resolution instead of silent drop; Jira sprint field is
  custom-field-dependent → tolerate absence; PR diffs are *not* indexed (code shape, Phase 2+)
  but PR review comments are; ticket moved across projects → external_id stays, breadcrumb
  refreshes on next sync; closed-item handling — keep indexed (history matters for KG),
  `status` metadata lets retrieval filter.

### Shape: record — Salesforce, HubSpot, Google/MS Calendar
- Calendars finally join the record family (fixes D3): whole-event chunks, `structured`
  treatment, `structured_fields` promotion (attendees, organizer, start/end, recurrence).
- CRM: keep humanized field lines; add `structured_owners` (Owner.Name + id → OWNS).
- Embedding: passage task, **no late chunking** (records are self-contained), child=whole
  record. For Jina, records additionally get the breadcrumb header (`Salesforce › Opportunity ›
  Acme Renewal`), which empirically matters more for short texts than task-type tweaks.
- Edge cases: >3000-char records (long descriptions) → field-group split: header fields chunk
  + description chunk(s), never mid-field; recurring calendar events → index master + next
  occurrence only (not 52 instances); declined/cancelled events → indexed with status, KG
  extraction skipped; empty CRM descriptions → header-only chunk is fine (still resolves
  entities); currency/locale — keep raw numeric in metadata, humanized in content.

### Shape: tabular — Snowflake/BigQuery/Redshift, Sheets, Drive-XLSX (D7 fix), OneDrive/SharePoint tables, uploads, LlamaParse tables
- Keep the stats/sample/agg triple — it is the right design. Upgrades:
  - **Vocabulary enrichment** (quality-first): one `simple`-tier call per table generating
    business-term aliases for table+columns ("`rev_amt` ≈ revenue, sales, ARR"), embedded into
    the stats chunk header. Closes the query-vocabulary gap without touching the model.
  - Drive XLSX routes through `tabularChunksFromParsed` (D7).
  - Column descriptions from warehouse comments (`information_schema` comment fields) included
    in stats chunk when present.
- Embedding: passage, no late chunking, child = whole stats/agg chunk (≤1200 tok ceiling;
  wide tables split by column-groups of 30 with table-name header re-emitted).
- Edge cases: 1000-column tables → column-group splits; all-numeric tables (no categorical
  dim) → sample falls back to plain rows (exists) + aggregation skipped (exists); PII-ish
  columns (email/ssn patterns) → sample chunk masks values, stats keeps distributions —
  flag-gated per org; empty tables → stats-only chunk; type-inference flips between syncs
  (numeric column suddenly has 'N/A' strings) → inference uses 95th-percentile rule rather
  than `every()`.

### Shape: bi_artifact — Looker, Metabase, Tableau, Power BI, dbt
- Split artifact-metadata chunks from data-sample chunks (today conflated under `tabular`):
  artifact chunks (look/dashboard/measure/model definitions) get breadcrumb + passage
  embedding; their row samples follow the tabular shape.
- DAX measures / LookML / dbt SQL: fence-atomic chunking, `codeFenceRatio` path.
- Edge cases: Tableau views needing parameters (fetch fails non-fatally today — keep, add
  telemetry); dashboards with 100+ tiles → tile-list chunk capped at 50 + count line.

### Shape: media — vision→text captions
- Sources: Notion image blocks, PDF figures (Docling emits picture provenance), Drive/OneDrive
  standalone images, Slack/Gmail attachments, BI chart PNG exports (Phase 4).
- Pipeline: media item → dedupe by content SHA → vision caption via `resolveModelClient`
  vision tier (BYOK-aware, falls back to system key) with shape-specific prompts (chart →
  "axes, series, trend, numbers"; diagram → "components and arrows"; photo → one line) →
  caption becomes a prose chunk: `[Image in {parent breadcrumb}]: {caption}` with
  `source_url` deep-linking the parent.
- Edge cases: decorative images (<10 KB, or repeated logo hash org-wide) → skip; captioning
  failure → placeholder chunk `[image: caption unavailable]` + retry queue; cost guard:
  per-org daily caption budget with overflow queued, never dropped; EXIF stripped (privacy)
  before any model call.

---

## PART II — Knowledge-Graph Construction, per shape

Extraction tiers replace the source-string gate (`extraction-gate.ts`):

| Tier | Shapes | Mechanism |
|---|---|---|
| **A — full LLM** | prose, email, work_item | general prompt + decision prompt (D1 fixed by shape routing) + module addenda |
| **B — gated LLM** | thread, record | regex signal gate (existing patterns + obligation/ownership verbs); records gate on description length > 200 chars (field-only records get deterministic edges, no LLM) |
| **C — deterministic only** | tabular, bi_artifact, media | **no LLM**: `extractSchemaEntities` wired into `builder.ts` for tabular (D2); artifact-name → `service`/`metric` nodes for BI; media caption inherits parent's extraction pass |

Deterministic structured extraction (all EXTRACTED/1.0, no LLM):
- `structured_links` (exists) — extended per Part I work_item.
- `structured_owners` → person node (resolved via identity table below) —OWNS/WORKS_ON→ item.
- Record field edges: SF Opportunity → `TIED_TO_ACCOUNT` account, owner OWNS, stage as
  metadata; calendar event → attendees `WORKS_ON`(meeting) edges gated to ≥2 internal
  attendees to avoid noise.
- Tabular: table `service` node + column `concept` nodes + FEEDS/PART_OF (revived D2 code).

LLM extraction upgrades (quality-first):
- The dual-prompt run gains a **third focused pass for blockers/obligations on work_item +
  thread** (higher recall than the general prompt; ~1 extra call per gated chunk — accepted).
- Entity grounding: every LLM-extracted person/team label is passed through
  `resolveEntity` + the identity table before node creation; unresolvable people are created
  with `metadata.unverified=true` so hierarchy roll-ups (Plan C) can quarantine them.
- Extraction batching stays at concurrency 5; JSON-retry logic exists; add per-org daily
  extraction budget with overflow re-queued (never silently skipped).

**Identity link table** (foundation for Plan C person scopes and §8 of the audit):
`org_member_identities(org_member_id, provider, account_id, display_label, confidence,
verified_at)` — populated during sync from `structured_owners.provider_account_id`, seeded by
email match, admin-confirmable in the Users admin page. All person-edge creation consults it
first; `my-work.ts` / `my-obligations.ts` drop the email-prefix heuristic.

Cross-team edge visibility (audit §8): structured work-graph edges (BLOCKS/BLOCKED_BY/
DEPENDS_ON/RESOLVED_BY between ticket/PR nodes) are written `visibility='org_wide'` — labels
and link only; underlying documents keep department RLS. LLM INFERRED blocker edges keep
department visibility (lower confidence, higher leak risk). This single change makes My Work
blocker chains cross departments for every member.

Exception handling (KG layer): upsertGraph compensating rollback exists; add idempotent
re-extraction on extraction-prompt version bump (`last_extracted_hash` becomes
`{hash}:{prompt_version}`); LLM JSON failures after retry → document flagged
`extraction_failed`, surfaced in admin sync health, retried next sync; node-merge visibility
must take **min** not max when merging cross-visibility chunks of the same doc (review
`maxVisibility` semantics — broadening visibility on merge is a leak vector; verify intent
before Phase 1 exit).

---

## Acceptance criteria (plan-level)

1. Zero provider-string routing tables remain; every fetcher declares `shape`.
2. Retrieval eval (golden-set per shape, 50 queries/org-fixture) shows ≥20% recall@5
   improvement on prose/email vs. main — gate for the re-embed migration rollout.
3. No document indexed under two embedding models within one org (SQL assertion in CI).
4. Email corpus: documents-per-email = 1; duplicate-text ratio across rows < 2%.
5. KG: BI tables produce zero LLM extraction calls and non-zero schema entities; decision
   nodes appear from Drive/Gmail/SharePoint fixtures (D1 regression test).
6. Every silent-drop path (images, unsupported binaries, oversized) emits a `sync_skips`
   metric with reason.
