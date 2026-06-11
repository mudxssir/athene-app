# Data Pipeline Audit V2 — Data Shapes × Connectors × Embedding × Knowledge Graph

_Generated 2026-06-11. Supersedes `DATA_TYPE_HANDLING_AUDIT.md` (the V1 audit grouped by
business vertical, and contains two material errors corrected here: the deterministic BI
schema extractor is dead code, and the provider-string routing mismatches were missed).
Every claim below was verified against code, with file:line references._

---

## 0. Executive Summary

1. **The pipeline routes everything on one string — `FetchedChunk.metadata.provider` — and
   five of its routing tables are keyed on values that fetchers never emit.** Gmail, Google
   Calendar and Drive all emit `provider: 'google'`; Outlook, MS Calendar, OneDrive and
   SharePoint all emit `provider: 'microsoft'`; uploads emit `'direct_upload'`. The chunking
   families, embedding hints, decision extraction, and Tier A/B lists are keyed on
   `'gmail'`, `'outlook'`, `'google_calendar'`, `'ms_calendar'`, `'google_drive'`,
   `'sharepoint'`, `'file_upload'` — **none of which ever match**. Consequences in §6.
2. **`extractSchemaEntities()` — the deterministic, no-LLM KG path for warehouse tables —
   is never called** (`bi-chunking.ts:269`, re-exported at `extractor.ts:20`, zero call
   sites). Instead, BI stats/sample/agg chunks fall through the Tier gate as "unknown →
   Tier A" and get **LLM entity extraction over statistical text**, the exact noise the
   deterministic path was built to avoid.
3. **The `'query'` embedding hint is never used.** All search-time embeddings
   (`vector-search.ts:37,109`, `entity-resolver.ts:129`) call `embed(text, orgId)` with no
   hint → on the Google provider, queries embed as `RETRIEVAL_DOCUMENT` instead of
   `RETRIEVAL_QUERY`, degrading asymmetric retrieval.
4. **The embedding fallback chain can mix incompatible vector spaces in one corpus.**
   Google → Jina → Together → Nomic → local BGE are all 768-dim but live in different
   embedding spaces; a mid-sync provider failure silently switches models
   (`embedding-factory.ts:296–341`) and the only guard is a dimension count.
5. **Cross-team blocker edges are department-private by design**, so the My Work blocker
   chain truncates at department boundaries for regular members (§8) — the single biggest
   architectural gap for "who is blocked on whom across teams".
6. The right fix is structural, not point patches: **fetchers should declare a
   `data_shape` enum on every chunk**, and every downstream gate (chunker, hint, tier,
   decision prompt, structured extraction) should key on shape — not on provider-string
   sets that drift every time a connector is added. Target architecture in §9.

---

## 1. Pipeline Anatomy (what actually runs, in order)

```
Fetcher → FetchedChunk { chunk_id, title, content (RAM-only), source_url, metadata.provider }
  → indexDocuments() (indexing.ts)
      1. upsertDocumentRecord()       — documents row, SHA-256 content-hash skip
      2. normalizeContent()           — HTML strip + entity decode + whitespace collapse (ALL content)
      3. chunkContent(provider)       — 5 families routed on metadata.provider
      4. resolveEmbeddingHint()       — 'structured' | 'document' (Google provider only)
      5. embedBatch()                 — BYOK → Google → Jina → Together → Nomic → local BGE, 768-dim
      6. document_embeddings upsert   — chunk_text persisted in metadata (zero-copy for KG)
  → graph-build worker (builder.ts)
      7. shouldRunExtraction()        — Tier A/B gate (Slack-only regex gate)
      8. extractEntitiesAndRelations()— LLM dual-prompt per chunk (general + decision)
      9. buildStructuredLinkGraph()   — Jira/Linear/GitHub links → EXTRACTED/1.0 edges, no LLM
     10. upsertGraph() → detectCommunities() (Louvain) → event extraction (fire-and-forget)
```

Routing key for steps 3, 4, 7, and the decision prompt in 8: **`metadata.provider`**
(stored as `documents.source_type` / `document_embeddings.source_type`).

---

## 2. The Master Routing Matrix (connector → what actually happens)

`✗` marks a row where the intended behavior does not fire because of a provider-string
mismatch. Chunking families: **record** = no split ≤3000 chars; **tabular** = no split
≤4000 chars else 768tok/96; **thread** = 768tok/128; **email** = 2000char/200;
**document** = 512tok/64 (default).

| Connector / surface | `provider` emitted | Chunking family applied | Intended family | Embed hint | Decision prompt | Structured links |
|---|---|---|---|---|---|---|
| Slack messages | `slack` | thread ✓ | thread | document | ✓ (gated Tier B) | — |
| Jira issues | `jira` | thread ✓ | thread | document | — | ✓ issuelinks |
| Linear issues | `linear` | thread ✓ | thread | document | — | ✓ relations |
| Linear cycles/projects | `linear` | thread ✓ | thread | document | — | — |
| GitHub issues/PRs/wiki | `github` | thread ✓ | thread | document | — | ✓ PR `RESOLVES` |
| Zendesk tickets/articles | `zendesk` | thread ✓ | thread | document | — | — |
| Gmail (indexed bodies) | `google` | **document ✗** | email | document | **✗** (keyed `gmail`) | — |
| Outlook emails | `microsoft` | **document ✗** | email | document | **✗** | — |
| Google Calendar events | `google` | **document ✗** | record | **document ✗** (no `structured`) | — | — |
| MS Calendar events | `microsoft` | **document ✗** | record | **document ✗** | — | — |
| Google Drive (narrative) | `google` | document ✓ | document | document | **✗** (keyed `google_drive`) | — |
| OneDrive / SharePoint (narrative) | `microsoft` | document ✓ | document | document | **✗** (keyed `sharepoint`) | — |
| Google Sheets | `google_sheets` | tabular ✓ | tabular | document | — | — |
| Drive PDF/DOCX tables (LlamaParse) | `google_drive_tabular` | tabular ✓ | tabular | document | — | — |
| OneDrive/SharePoint tables | `onedrive_tabular` / `sharepoint_tabular` | tabular ✓ | tabular | document | — | — |
| Notion pages/databases | `notion` | document ✓ | document | document | ✓ | — |
| Confluence pages | `confluence` | document ✓ | document | document | ✓ | — |
| Salesforce (4 fetchers) | `salesforce` | record ✓ | record | structured ✓ | — | — |
| HubSpot (4 fetchers) | `hubspot` | record ✓ | record | structured ✓ | — | — |
| Snowflake / BigQuery / Redshift | `snowflake`/`bigquery`/`redshift` | tabular ✓ | tabular | document | — | — |
| Looker / Metabase / Tableau / Power BI / dbt | own name ✓ | tabular ✓ | tabular | document | — | — |
| File uploads (tabular) | `direct_upload_tabular` | tabular ✓ | tabular | document | — | — |
| File uploads (narrative) | `direct_upload` | document ✓ | document | document | **✗** (keyed `file_upload`) | — |

**Net effect of the ✗ rows:** decision extraction — a flagship feature ("decision memory")
— only ever runs for **Notion, Confluence, and Slack**. It is silently disabled for Gmail,
Outlook, Drive, OneDrive, SharePoint, and uploads, which are precisely the sources meeting
notes and decision documents live in. Calendar events never get record treatment,
`structured_fields` promotion (`indexing.ts:299`), or the `structured` hint.

---

## 3. Data-Shape Taxonomy (the better grouping)

The pipeline's real differentiator is the *shape* of the content, not the vendor or the
business vertical. Ten shapes cover every connector. This is the axis the doc — and the
code — should be organized around.

### Shape 1 — Prose documents (markdown / plain text)
**Producers:** GitHub wiki (markdown, pre-split by `## ` headings at `wiki-fetcher.ts:114`),
Notion pages (block tree → markdown, `pages-fetcher.ts:101–131`), Confluence (HTML →
`stripHtml`), Zendesk articles (HTML-stripped), Drive Google Docs (`export?mimeType=text/plain`),
Slides (text export, layout lost), OneDrive/SharePoint DOCX/PDF narrative text, upload narrative.
**Handling:** `normalizeContent` → 512 tok / 64 overlap → `document` hint → Tier A LLM
extraction. Dual decision prompt fires only for notion/confluence (see ✗ rows above).
**Issues:**
- `normalizeContent` (`indexing.ts:113–122`) strips *any* letter-prefixed `<...>` span.
  Code-bearing prose — Notion/Jira/wiki code fences containing `List<String>`,
  `<Component>`, generics — gets silently corrupted before embedding. The SQL-operator
  guard (`WHERE age < 30`) survives; markup-like code does not.
- Notion image blocks return `''` (`blockToText` falls through for rich-text-less blocks)
  — embedded images vanish with no placeholder, so nobody can tell content was dropped.

### Shape 2 — Rich-text trees (ADF, Notion blocks, HTML)
Not a storage shape — a **conversion stage** feeding shapes 1/5. Three tree-walkers exist:
`adf-to-text.ts` (Jira/Confluence ADF), `pages-fetcher.ts:blockToText` (Notion, depth-cap 10),
`stripOutlookHtml` (`microsoft/index.ts:17`) + `confluence-html.ts`. All lossy in the same
ways: tables flatten to text, images drop, layout semantics gone.
**Recommendation:** one shared `richTextToMarkdown` module with a documented loss profile,
plus a `[image: alt]` placeholder convention so dropped media is at least visible.

### Shape 3 — Email messages
**Producers:** Gmail (`gmail-fetcher.ts:261`, MIME walk + base64 decode), Outlook
(`microsoft/index.ts:61–131`, Graph HTML → strip).
**Actual handling — both fetchers pre-chunk** (2000 char / 200 overlap) and emit each
slice as a **separate FetchedChunk with its own chunk_id** (`gmail:{id}:{idx}`,
`ms_email_{id}:{idx}`). Because `documents.external_id = chunk_id`, every slice becomes its
own `documents` row:
- The email ceases to exist as a unit: citations, KG extraction, and content-hash dedup
  all operate on arbitrary 2000-char windows.
- The 200-char overlap is *duplicated across documents* — retrieval returns near-identical
  neighbors as distinct sources.
- The indexing-level email chunker (`chunkEmail`, `indexing.ts:72`) is dead for real email
  (provider `google`/`microsoft` routes to document family anyway) — each slice (~450–550
  tokens) then re-chunks at 512 tokens, occasionally splitting a slice in two.
**Recommendation:** fetchers emit ONE chunk per email (full body); let the pipeline chunk.
Pre-chunking at the fetcher is only legitimate when the fetcher knows a semantic boundary
the tokenizer can't see — email has none.

### Shape 4 — Chat threads
**Producer:** Slack only (`channels-fetcher.ts`): one FetchedChunk **per root message**, thread
replies appended inline (`→` prefix), 30-day window, public channels only, bots dropped.
**Handling:** thread family 768/128 → Tier B regex gate (`extraction-gate.ts:38`) → LLM
only on decision/blocker/obligation signal. The only content-aware gate in the pipeline —
and the correct pattern to generalize.
**Issues:** every new reply mutates the root document's content hash → full re-embed +
re-extract of the whole thread per reply (churn). Thread identity is lost across the
30-day fetch horizon. DM/private channels (by scope) absent.

### Shape 5 — Work items (tickets, PRs, issues)
**Producers:** Jira (`jira-fetcher.ts:93–140` — ADF description + last-10 comments +
status/assignee/priority/sprint header lines), Linear (`issues-fetcher.ts:196–237` —
markdown + 5 comments + state/team/assignee/labels), GitHub issues/PRs (body + comments /
reviews), Zendesk tickets (subject + description + comment thread).
**Handling:** thread family ✓; Tier A; **structured links → deterministic EXTRACTED/1.0
graph edges** (`structured-links.ts`) — Jira issuelinks (BLOCKS/BLOCKED_BY/DEPENDS_ON/
RELATED_TO), Linear relations + inverseRelations, GitHub `closingIssuesReferences` →
RESOLVES (swapped to RESOLVED_BY).
**This is the best-designed shape in the pipeline.** Gaps:
- **Assignees are not structured.** "Assignee: X" sits in prose and metadata, and OWNS/
  WORKS_ON edges depend on the LLM noticing it. The data is deterministic in every payload
  (Jira `assignee.displayName`, Linear `assignee.name`, GitHub author). A `structured_owners`
  field parallel to `structured_links` would make ownership EXTRACTED/1.0 — directly
  powering My Work (§6.1) and the responsibilities surface (§8).
- Provider account IDs (Jira accountId, Linear user UUID, GitHub login, Slack user id) are
  discarded — only display names survive — forcing fuzzy person resolution later.
- GitHub issue↔issue references and Linear project/cycle containment produce no links.

### Shape 6 — Business records (CRM rows, calendar events)
**Producers:** Salesforce ×4 (humanized field lines, `opportunities-fetcher.ts:57–66`),
HubSpot ×4, both calendars (event summary lines).
**Handling (CRM):** record family — whole record = 1 chunk ≤3000 chars; `structured`
hint; `structured_fields` promoted into embedding metadata for faceted filtering
(`indexing.ts:128`, keys at `:60`). Correct design.
**Handling (calendars):** all of it ✗ — routed as plain documents (provider mismatch).
Calendar events are the purest key-value records in the system and get none of the record
machinery. Additionally no obligation/owner extraction happens on them (Tier A LLM runs,
but the general prompt rarely yields structure from "Event/When/Attendees" text).

### Shape 7 — Tabular datasets
**Producers (two engines, same output contract):**
- *Warehouse:* Snowflake/BigQuery/Redshift run SQL server-side, then `bi-chunking.ts`
  builds **stats** (schema + min/max/avg/sum, top-N categoricals, date ranges), **sample**
  (rows grouped by auto-detected primary dimension, `detectPrimaryDimension`:
  distinct > 2 and < 80% unique), and **agg** (top-3 numerics × top-2 categoricals,
  GROUP-BY top-10) chunks per table.
- *In-memory:* `tabular-analysis.ts` re-implements the same stats/sample/agg over parsed
  rows (cap 10 000) for Google Sheets, LlamaParse-extracted PDF/DOCX tables,
  OneDrive/SharePoint spreadsheets, and uploads — plus an optional LLM narrative
  `:analysis` chunk (uploads only, `withLlmAnalysis`).
**Handling:** tabular family (no split ≤4000 chars — most stats/agg chunks fit whole ✓).
**Issues:**
- **KG: the deterministic path is dead** (`extractSchemaEntities` never called) and the
  LLM extractor runs over statistical text instead (unknown source → Tier A). Wire the
  deterministic path into `builder.ts` for this shape and make the shape **Tier C: no LLM**.
- **Drive XLSX misses the tabular engine entirely**: `.xlsx` is not in
  `LLAMAPARSE_BINARY_TYPES` (`drive-fetcher.ts:303`), so it falls back to
  `extractXlsxText` → 200-row header-prefixed CSV windows concatenated into one string →
  provider `google` → **512-token document chunker re-splits mid-window**, defeating the
  headers-repeated design. Route Drive XLSX through `tabularChunksFromParsed` exactly like
  Sheets (`fetchSheetChunks`) and OneDrive already do.
- `inferSchema` samples 50 rows; boolean/json/array columns classify `other` → invisible
  to stats and (future) schema KG.

### Shape 8 — BI artifacts (reports, dashboards, measures, models)
**Producers:** Looker (looks = first-50 query rows as `col: value`; dashboards = tile
titles; LookML explores), Metabase (cards = first-30 rows; dashboards), Tableau (workbook
metadata; views = 50-row CSV sample, failure non-fatal), Power BI (reports, datasets,
**DAX measures as `powerbi_measure` chunks**, dashboards), dbt (models/jobs).
**Handling:** tabular family (fine — mostly short, no split). LLM extraction runs (Tier A
by default) — marginally useful for artifact names, noisy for row dumps.
**Recommendation:** treat artifact-metadata chunks as shape 8 (extract `service`/`metric`
nodes deterministically from names — a Looker look IS a metric definition) and row-sample
chunks as shape 7 Tier C.

### Shape 9 — Binary containers (PDF / DOCX / XLSX / PPTX)
Resolution matrix (all paths verified):

| Format | Drive | OneDrive/SharePoint/uploads | Output shape |
|---|---|---|---|
| PDF (text) | LlamaParse if key, else `pdf-parse` (50 MB cap, 30 s timeout) | same via `parseDocumentEnhanced` | 1 + 7 (tables) |
| PDF (scanned) | LlamaParse OCR if key, else `[PDF contains no extractable text]` | same | 1 or sentinel |
| DOCX | LlamaParse if key, else `mammoth.extractRawText` (tables flattened) | same | 1 + 7 |
| XLSX | **`extractXlsxText` flat CSV (bug above)** | ExcelJS / xlsx → `ParsedTable[]` → tabular engine ✓ | 7 |
| PPTX/PPT | LlamaParse if key, else skip-sentinel | same | 1 or skipped |
| Images / ZIP / other | `[Unsupported binary format]` (skipped at `drive-fetcher.ts:358`) | skip-sentinel **indexed as content** | — |

Note the asymmetry: Drive *drops* unsupported-format chunks; the Microsoft/upload path
*indexes the sentinel string* (`[Unsupported file type: .pptx — skipped]` becomes a real
embedded document). Pick one behavior (drop) everywhere.

### Shape 10 — Media & code (currently absent)
Images anywhere (Notion blocks, PDF figures, Tableau/Looker/Metabase chart PNGs, Slack
file attachments, Gmail attachments — fetcher exists at `gmail-fetcher.ts:169` but is
never called in the indexing flow) → dropped, usually silently. Repository code files →
not fetched at all. Both are Phase-2 multimodal/code-RAG decisions, not bugs — but the
*silent* dropping is a bug-adjacent observability gap: emit placeholders + a per-sync
"skipped content" count.

---

## 4. Embedding Layer — per data type and app (how it actually works)

**One vector space for everything.** All shapes, all connectors → 768 dims into
`document_embeddings.embedding`. Provider chain per call (`embedding-factory.ts`):

```
org BYOK (OpenAI text-embedding-3-small MRL-768, or Jina v3)
  → GOOGLE_API_KEY  (text-embedding-004, task-typed)
  → JINA_API_KEY    (jina-embeddings-v3, task "retrieval.passage" hardcoded)
  → TOGETHER        (m2-bert-80M-8k)
  → NOMIC           (nomic-embed-text-v1.5)
  → local Xenova bge-base-en-v1.5 (int8, last resort)
```
2 retries per provider, 500 ms linear backoff, then next provider; batch 96; failed
batches yield empty placeholders that are filtered before upsert (rows simply missing).

**The entire per-data-type differentiation is one parameter** — `EmbeddingHint`:

| Hint | Set for (intended) | Set for (actual) | Effect |
|---|---|---|---|
| `structured` | CRM + calendars | **Salesforce, HubSpot only** (calendars miss on provider string) | Google: `SEMANTIC_SIMILARITY` task |
| `document` | everything else | everything else | Google: `RETRIEVAL_DOCUMENT` |
| `query` | search time | **never — no call site passes it** | would be `RETRIEVAL_QUERY` |

Jina/Together/Nomic/OpenAI/local ignore the hint entirely (Jina is hardcoded to
`retrieval.passage` even for queries).

**Findings, in priority order:**
1. **Query/document asymmetry broken** — pass `'query'` in `vector-search.ts:37,109` and
   `entity-resolver.ts:129`; pass it through Jina as `task: 'retrieval.query'` too. This
   is a two-line change with measurable retrieval impact on the Google and Jina paths.
2. **Vector-space mixing.** Fallback switches models *per call*, mid-corpus, silently.
   Store `(provider, model)` on every `document_embeddings` row, filter search to the
   org's active model, and re-embed on provider change. Until then a single Google outage
   during a sync poisons that org's recall in ways no dashboard will show.
3. **Hint is derived per batch from the first item** (`indexing.ts:429`). The Microsoft
   fetcher returns email + calendar + OneDrive + SharePoint + tabular chunks in ONE array,
   so the "batch is homogeneous" comment is false for the multi-surface connectors. Make
   the hint per-item (group texts by hint before batching).
4. **What grouping by data type should mean here** (and what V1's vertical grouping hid):
   the right unit of embedding policy is the shape, not the connector —
   - shapes 1–3 (prose/email): `RETRIEVAL_DOCUMENT`, current chunk sizes fine;
   - shapes 4–5 (threads/work items): `RETRIEVAL_DOCUMENT`; consider prepending a one-line
     context header (`[#channel] / [PROJ-123 status]`) — Jira/Linear already do this in
     content, Slack does not (title has it, content doesn't);
   - shape 6 (records): `SEMANTIC_SIMILARITY` (works today for CRM, fix calendars);
   - shapes 7–8 (tabular/BI): `RETRIEVAL_DOCUMENT` is fine — but the bigger lever is that
     stats/agg chunks are *generated text* whose vocabulary you control: include synonyms
     of the business entity ("revenue/ARR/sales") in the stats header to close the
     query-vocabulary gap, rather than reaching for a second embedding model.
   One shared 768-space remains the right call at this scale — per-shape *models* would
   fragment recall and multiply ops cost; per-shape *task types and text construction*
   are where the wins are.

---

## 5. Knowledge-Graph Building — per data shape

| Shape | Extraction path today | Should be |
|---|---|---|
| Prose (1) | LLM general prompt; + decision prompt for notion/confluence only (✗ drive/sharepoint/gmail/uploads) | LLM general + decision keyed on shape |
| Email (3) | LLM general only (✗ decision) — over 2000-char slices | one doc per email; general + decision + obligation focus |
| Threads (4) | Tier B regex gate → LLM on signal ✓ | keep; add obligation patterns ✓ (already present) |
| Work items (5) | LLM general + `structured_links` → EXTRACTED/1.0 ✓ | + `structured_owners`, + team/project PART_OF edges |
| Records (6) | LLM general (CRM yields deal/account/contact via RevOps module addendum) | + deterministic edges from record fields (Owner→OWNS, Account→TIED_TO_ACCOUNT) — fields are already parsed, no LLM needed |
| Tabular (7) | **LLM over stats text (noise); deterministic extractor dead** | Tier C: `extractSchemaEntities` only, no LLM |
| BI artifacts (8) | LLM over artifact text | deterministic `service`/`metric` nodes from artifact names |

Mechanics verified: builder reads persisted `chunk_text` (never re-fetches), SHA-256
extraction dedup, per-doc delete-then-reinsert with compensating rollback, dual prompts in
parallel (`extractor.ts:305`), node merge on `(org_id, label, entity_type)` with
department-id union, edge merge keeps strongest provenance / max confidence, Louvain
communities post-batch, event extraction fire-and-forget. Module addenda (RevOps /
Engineering / CS / Legal) inject extra entity types via per-org resolver — this vertical
layer is *additive prompt text*, so it composes fine with shape-based routing.

**Provenance discipline** (the part V1 got right and is worth preserving): structured
links are the only EXTRACTED/1.0 edges by construction; LLM blocking language is INFERRED
0.6–0.9; UI (My Work) renders non-EXTRACTED as "Possibly:" with dashed borders. The
normalizer hard-forces EXTRACTED → 1.0 (`extractor.ts:140`).

---

## 6. Defect Register

| # | Sev | Defect | Evidence | Fix |
|---|---|---|---|---|
| D1 | P0 | Decision extraction never fires for Drive/SharePoint/OneDrive/Gmail/Outlook/uploads (provider ≠ key) | `extractor-prompt.ts:174` vs `drive-fetcher.ts:283`, `microsoft/index.ts:104`, `upload/route.ts:255` | route on shape; or add `google`,`microsoft`,`direct_upload` short-term |
| D2 | P0 | `extractSchemaEntities` dead code — BI tables get LLM noise instead of deterministic schema graph | zero call sites; `builder.ts` never imports it | call it in `builder.ts` for shape 7 + make shape 7 Tier C |
| D3 | P1 | Calendars (both) never get record chunking / `structured` hint / `structured_fields` | `indexing.ts:35–38` keys `google_calendar`,`ms_calendar`; fetchers emit `google`,`microsoft` | per-shape routing |
| D4 | P1 | Gmail/Outlook: emails fragmented into per-slice `documents` rows; overlap duplicated across docs; email chunker dead | `gmail-fetcher.ts:330–351`, `microsoft/index.ts:96–113` | emit one chunk per email |
| D5 | P1 | Search queries embedded without `query` hint | `vector-search.ts:37,109`, `entity-resolver.ts:129` | pass hint; map in Jina path too |
| D6 | P1 | Embedding fallback mixes vector spaces silently | `embedding-factory.ts:296–341` | persist model per row; filter at search; alert on fallback |
| D7 | P2 | Drive XLSX bypasses tabular engine; 200-row windows re-split at 512 tok | `drive-fetcher.ts:303` (`xlsx` absent), `:225–268` | route via `tabularChunksFromParsed` |
| D8 | P2 | `normalizeContent` corrupts code-like text (`<T>`, `<Component>`) in all prose | `indexing.ts:115` | skip inside fenced blocks, or only strip known HTML tags |
| D9 | P2 | Mixed-provider arrays get one embedding hint from first item | `indexing.ts:429` | group by hint |
| D10 | P2 | Tier A/B list mostly keyed on never-emitted values (latent: breaks when Tier B grows) | `extraction-gate.ts:15–28` | shape-keyed tiers |
| D11 | P2 | MS/upload paths index skip-sentinel strings as real content; Drive drops them | `microsoft/index.ts` vs `drive-fetcher.ts:358` | drop everywhere + skipped-content counter |
| D12 | P3 | Notion images / chart PNGs / Slack & Gmail attachments dropped silently (Gmail attachment fetcher exists, never called) | `pages-fetcher.ts:91`, `gmail-fetcher.ts:169` | placeholders + per-sync skip metrics |

---

## 7. Per-Vertical Module Layer (unchanged, and correctly orthogonal)

The four module addenda (RevOps, Engineering, CS, Legal — `modules/registry.ts`) activate
by connected sources and add entity types to the extraction prompt. This is the right
place for *vertical* knowledge — it's prompt content, not pipeline routing. Keep verticals
here; remove them from chunking/embedding decisions entirely (they never belonged there,
which is why V1's vertical-grouped audit obscured the real routing bugs).

---

## 8. Cross-Team Relationship Architecture — blockers & responsibilities

What the user-facing promise needs: *"my ticket is blocked by a ticket owned by another
team in another department, and both sides can see that."* Current mechanics:

**How blocker chains form**
1. Source-system links → `structured_links` → EXTRACTED/1.0 BLOCKS/BLOCKED_BY/DEPENDS_ON
   edges (Jira, Linear, GitHub PRs only).
2. Prose ("waiting on legal review") → LLM INFERRED 0.6–0.9 edges, Slack gated by regex.
3. My Work (`my-work.ts`) resolves the person node (display-name / email-prefix heuristic
   via alias-aware `resolveEntity`), collects OWNS/WORKS_ON tickets/PRs, runs a 2-hop BFS
   over blocker relations, resolves owners of blockers, deep-links source docs.

**Where it breaks across departments**
- **Edges carry a single `department_id` (the source document's) and RLS hides them
  cross-dept** (`rls_policies.sql:310–325`): members see edges only when `org_wide`, same
  department, or via super_user grant. Nodes union `department_ids` across documents
  (`extractor.ts:374`), so both teams may see both *endpoints* — but not the *edge*
  between them. A dept-A member's My Work BFS silently truncates exactly at the boundary
  where cross-team coordination matters most.
- **Person identity is fuzzy.** org_member ↔ KG person linkage is name/email-prefix
  matching at query time. Jira accountId / Linear user UUID / GitHub login / Slack user id
  are all present in fetcher payloads and all discarded. Two "Alex"es in one org, or a
  person whose GitHub login differs from their display name, mis-route responsibilities.
- **Responsibility edges depend on the LLM.** Assignee fields are deterministic in every
  work-item payload but only become OWNS/WORKS_ON if the LLM extracts them from the prose
  header lines.
- **Teams aren't first-class.** Linear team, Jira project, GitHub repo, Slack channel are
  in metadata/content but never become `team`/`project` nodes with PART_OF containment —
  so there is no graph answer to "which team is the bottleneck for dept X", only
  per-person chains.

**Recommended target (ordered by leverage):**
1. **Work-graph edges should be org-wide.** Blocking/dependency edges between tickets/PRs
   are coordination data, not departmental secrets; the content stays RLS-protected via
   the source document — the *edge + labels* should not. Either default
   `visibility='org_wide'` for structured-link edges in `structured-links.ts`, or give
   edges a `department_ids[]` array (union of both endpoints' departments) like nodes.
   Without one of these, §6.1's cross-source blocker promise only holds for admins.
2. **`structured_owners`** (mirror of `structured_links`): fetchers emit
   `{person_label, provider_account_id, relation: 'OWNS'|'WORKS_ON'}` per work item /
   CRM record / calendar organizer → deterministic EXTRACTED/1.0 responsibility edges.
3. **Identity link table** `org_member_identities (org_member_id, provider, account_id,
   display_label)` populated during sync from the IDs currently discarded; make
   `resolveEntity` consult it first. Kills the email-prefix heuristic in `my-work.ts` and
   `my-obligations.ts`.
4. **Deterministic team/project containment**: ticket —PART_OF→ project/team node (from
   Linear team, Jira project key, GitHub repo). Combined with (1)+(2), this turns
   "blockers across teams and verticals" into a pure graph query: blocked items grouped
   by owning team of the blocker, with department rollup via members' departments.
5. **Obligations**: the extraction prompt already yields `obligation` entities and the
   Tier-B gate already promotes deadline/commitment language; with (3), obligations bind
   to real org members instead of name-matched person nodes.

---

## 9. Target Architecture — one declared shape, all routing keyed on it

```ts
// base.ts
export type DataShape =
  | 'prose' | 'email' | 'thread' | 'work_item' | 'record'
  | 'tabular' | 'bi_artifact' | 'media' | 'code'

export interface FetchedChunk {
  ...
  shape: DataShape            // REQUIRED — set by the fetcher, which knows
  metadata: { provider: string; ... }
}
```

Then every routing table collapses to one switch each:
- `chunkContent(shape)` — prose 512/64 · email 2000c/200 · thread 768/128 · work_item
  768/128 · record no-split · tabular no-split≤4000 · bi_artifact no-split
- `resolveEmbeddingHint(shape)` — record → `structured`; all else `document`; search → `query`
- `extractionTier(shape)` — thread → B (regex gate) · tabular/bi_artifact → **C
  (deterministic only)** · all else A
- `decisionPrompt(shape)` — prose | email | thread
- structured extraction — work_item → links+owners · record → field edges · tabular →
  schema entities

Provider strings stay for citation/branding/connector identity only. The five drifting
string-sets (`EMAIL_`, `RECORD_`, `TABULAR_`, `THREAD_SOURCE_TYPES`, `TIER_A/B`,
`DECISION_SOURCE_TYPES`) are deleted. Migration is mechanical: add `shape` to each
fetcher's chunk constructor (~25 one-line edits), keep the string-sets as a fallback for
unmigrated paths for one release, then remove.

**Sequencing suggestion:** D5 (query hint — 2 lines) and D1 (decision sources — 1 line)
ship today as string patches; D2+D7 (BI determinism) next; the `shape` field as a
standalone PR; then §8 items 1–3 as the foundation for the cross-team blocker/
responsibility surface.

---

_Verified against: `lib/integrations/indexing.ts`, `base.ts`, `bi-chunking.ts`,
`tabular-analysis.ts`, `llamaparse-client.ts`, `microsoft/document-parser.ts`, all
connector fetchers under `lib/integrations/*`, `lib/ai/embedding-factory.ts`,
`lib/langgraph/tools/chunker.ts`, `lib/tools/vector-search.ts`,
`lib/knowledge-graph/{builder,extractor,extractor-prompt,extraction-gate,
structured-links,types,entity-resolver,community,my-work}.ts`,
`supabase/migrations/20260101000002_rls_policies.sql`,
`20260529000001_fix_kg_nodes_rls_dept_cast.sql`._
