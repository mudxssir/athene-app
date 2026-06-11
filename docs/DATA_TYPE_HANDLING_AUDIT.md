# Data Type Handling Audit — Chunking, Embedding & KG per Connector

_Generated 2026-06-11. Covers the full indexing pipeline from `FetchedChunk` through KG extraction._

---

## Core Pipeline Design

The pipeline has one central orchestrator (`lib/integrations/indexing.ts`) that dispatches to five chunking strategies based on **source type family** — not individual connector. Every connector produces a `FetchedChunk` with:

- `content` — text, RAM-only, never persisted directly (stored as `chunk_text` in `document_embeddings.metadata`)
- `metadata` — filterable fields only; body content is forbidden (enforced by `assertSafeMetadata()`)

KG extraction re-reads from `metadata->>'chunk_text'` — it never re-fetches from the live source.

---

## Chunking — Five Families

| Family | Connectors | Chunk Size | Overlap | Logic |
|--------|-----------|-----------|---------|-------|
| **Email / prose** | Gmail, Outlook | 2 000 chars | 200 chars | Breaks at sentence/paragraph boundaries |
| **Structured records** | Salesforce, HubSpot, Google Calendar, MS Calendar | No split (≤ 3 000 chars) | — | Entire CRM record = 1 chunk; field relationships preserved |
| **Tabular / BI** | Snowflake, BigQuery, Redshift, Looker, Tableau, Metabase, dbt, Power BI | 768 tokens | 96 tokens | Larger windows keep column headers in context across splits |
| **Threaded / conversational** | Slack, Zendesk, Jira, Linear, GitHub | 768 tokens | 128 tokens | More overlap preserves thread relationships |
| **Long-form documents** | Drive, SharePoint, Notion, Confluence | 512 tokens | 64 tokens | Generic document chunking |

> **Note:** Differentiation is real but coarse — it is by family, not by individual connector. A Slack message and a GitHub issue get identical chunking parameters despite being very different artifacts.

---

## Per-Vertical, Per-Connector Detail

---

### Engineering (GitHub, Jira, Linear)

All three convert to a flat prose string before chunking (threaded family: 768 tokens / 128 overlap).

#### Jira
- **Raw format:** Atlassian Document Format (ADF) — nested JSON tree, NOT plaintext
- **Pre-processing:** `adf-to-text.ts` recursive descent: paragraphs → plain text + `\n\n`, headings preserved, lists get `• ` prefix, code blocks get backtick fences
- **Comments:** Expanded inline via `fields=comment` (zero extra API cost); last 10 comments appended with author names
- **Sync scope:** Project key filtering via JQL `project IN (...)`

#### Linear
- **Raw format:** Markdown (passed through as-is)
- **Pre-processing:** Priority mapped from numeric 0–4 to human labels; comments joined
- **Sync scope:** Team filtering via GraphQL `filter: { team: { id: { in: $teamIds } } }`
- **Cycles/Projects:** Both now accept `syncConfig`; projects filtered via `teams: { some: { id: { in: $teamIds } } }`

#### GitHub
- **Raw format:** Markdown body (passed through as-is)
- **Pre-processing:** Comments joined with `---` separator; no special handling for code blocks, diffs, or referenced PRs
- **Gap:** No repository file/code fetcher — a PR body mentioning a function gets indexed, the actual function does not

---

### Legal & Compliance (SharePoint, Google Drive, Notion)

#### Google Drive
Differentiates at fetch time by MIME type:

| MIME / Extension | Method | Output |
|-----------------|--------|--------|
| Google Docs | Export `text/plain` | Clean prose |
| Google Sheets | Export CSV → XLSX.js parse | **200-row windows with headers repeated on every chunk** |
| Google Slides | Export `text/plain` | Slide titles + body text; no layout |
| PDF (text) | `pdf-parse` | Extracted plain text |
| PDF (image-only) | `pdf-parse` fails | `[PDF contains no extractable text (image-only?)]` |
| DOCX | `mammoth.extractRawText()` | Plain text; no table structure |
| PPTX, images, ZIP | — | `[Unsupported binary format: .ext — skipped]` |
| Text / CSV / TSV | `buffer.toString('utf-8')` | Plain text |

#### SharePoint
Same `parseDocumentEnhanced()` path as Drive. Uses `LLAMAPARSE_EXTS = ['pdf', 'docx', 'pptx', 'ppt']`:
- **If `LLAMAPARSE_API_KEY` is set:** LlamaParse handles PDF/DOCX/PPTX with table extraction + OCR fallback
- **Otherwise:** Falls back to flat text (`mammoth` for DOCX, `pdf-parse` for PDF; PPTX gets skip-sentinel)

#### Notion
- **Raw format:** Block tree (paragraphs, headings, lists, code, toggles, columns, etc.)
- **Pre-processing:** `blockToText()` recursive descent converts to Markdown; depth > 10 returns empty string
- Block mapping: `heading_1/2/3` → `# / ## / ###`, `bulleted_list_item` → `- `, `code` → triple-backtick fenced block, `quote` → `> `, `to_do` → `[x]` / `[ ]`
- Databases: separate `databases-fetcher.ts` reads property values as key-value text
- **Gap:** Embedded image blocks silently return empty string — images in pages are dropped

---

### Revenue Operations (Salesforce, HubSpot)

Both use `RECORD_SOURCE_TYPES` — no splitting, entire record = 1 chunk.

#### Salesforce
- **Opportunities:** Amount (`toLocaleString()`), CloseDate (locale date string), Probability (with `%`), Stage, Account, Owner — humanized before embedding
- **Additional:** `structured_fields` extracted from metadata (stage, amount, probability, close_date, owner, etc.) for faceted filtering without similarity search
- **Sync scope:** `WHERE LastModifiedDate >= ...` delta filtering
- **Gaps:** Attachments on Opportunity records not fetched; Contacts fetcher now exists; `syncConfig` filtering added via `GENERIC_BROWSABLE`

#### HubSpot
- Contacts, Companies, Deals, Notes indexed as prose records
- Same structured record treatment as Salesforce
- **Gaps:** Associated emails, meetings, and file attachments on CRM records not indexed

---

### BI & Analytics (Snowflake, BigQuery, Redshift, Looker, Metabase, Tableau)

This is the most data-type-aware part of the pipeline.

#### Snowflake / BigQuery / Redshift
Generates **three distinct chunk types per table** via `bi-chunking.ts`:

1. **Stats chunk** — schema + column statistics:
   - Numerics: min / max / avg / sum
   - Categoricals: distinct count + top-N values with counts
   - Dates: min / max range

2. **Sample chunk** — representative rows:
   - Detects most-cardinal categorical column (`distinct > 2`, `< 80%` unique ratio)
   - Groups rows by primary dimension; 3 rows per group, up to 10 groups
   - Falls back to plaintext rows if no grouping detected

3. **Aggregation chunk** — pre-computed GROUP BY results:
   - Top-3 numeric columns × top-2 categorical columns
   - `GROUP BY category, SUM/AVG metric ORDER BY DESC LIMIT 10`

**Deterministic KG extraction** (no LLM): `extractSchemaEntities()` creates `service` nodes for tables, `concept` nodes per column, wired with `FEEDS`/`PART_OF` edges at confidence 1.0. Only place in the pipeline where KG bypasses the LLM entirely.

#### Looker
- **Looks:** Runs query (`POST /looks/{id}/run/json`), indexes first 50 result rows as `col: value` pairs
- **Dashboards:** Fetches tile titles and subtitles
- **Explores:** `GET /api/4.0/lookml_models` — indexes all LookML models with dimension/measure field definitions and types (analyst discoverability)

#### Tableau
- **Workbooks:** Metadata only (name, description, project, view list)
- **Views:** Fetches CSV sample via `GET /api/3.21/sites/{siteId}/views/{viewId}/data.csv?pageSize=50`; failure is non-fatal (some views require parameters)
- **Gap:** Chart/visualization images (PNG exports) are silently skipped

#### Metabase
- **Questions (Cards):** Runs query (`POST /card/{id}/query`), indexes first 30 result rows as `col: value` pairs
- **Dashboards:** Metadata only (name, description)

---

### Customer Success (Zendesk, Intercom)

#### Zendesk
- **Tickets:** Subject + description + comment thread
- **Help Center articles:** Title + body (HTML stripped by content normalization)
- Chunked as conversational (768 tokens / 128 overlap)

---

## Embedding — Barely Differentiated

Embedding is almost completely uniform across all data types:

- **Single model, single dimensionality** (768 dims), same provider chain for all content
- **Only differentiation:** `hint` parameter — CRM records and calendar events get `hint: "structured"` → `SEMANTIC_SIMILARITY` task type on Google provider. Everything else gets `hint: "document"` → `RETRIEVAL_DOCUMENT`
- Other providers (Jina, Together, Nomic) **ignore the hint entirely**
- **Batch size:** 96 texts per API call

A 500-row Snowflake stats chunk, a Slack message, and a 10-page legal brief all go through identical embedding. The 768-dimensional vector space does all the differentiation work — the pipeline doesn't assist it.

**Missing:** No domain-specific embedding models per vertical. No query/document embedding separation at index time (the `query` hint exists only at search time).

---

## KG Extraction — Vertically Aware via Module Prompts

KG builder (`builder.ts`) passes stored `chunk_text` to `extractEntitiesAndRelations()` via a per-chunk LLM call with two parallel prompts (general + decision extraction). The extractor has **no awareness of source type** at extraction time.

Vertical differentiation happens via the module registry injection of `extraction_prompt_addendum`:

| Module | Activating Sources | Extra Entity Types |
|--------|------------------|--------------------|
| **Revenue Ops** | salesforce, hubspot | deal, account, contact, persona, objection, win_reason, loss_reason, competitor |
| **Engineering** | github, linear, jira | incident, runbook, pull_request, tech_debt_item, sla_item, on_call_rotation, architecture_decision |
| **Customer Success** | zendesk, intercom, salesforce | customer, feature_request, bug_report, renewal, health_score, success_plan |
| **Legal & Compliance** | google_drive, sharepoint, notion | contract, clause, counterparty, regulation, risk_item, audit_finding |

### Tier A/B Gate (Slack Only)
Slack chunks only get LLM extraction if `shouldRunExtraction()` detects decision/blocker signal patterns. Plain chatter gets embeddings only, no LLM call. This is the **only content-aware routing** in the KG pipeline — it does not exist for BI data, which arguably needs it more (stats chunk content produces noise through entity extraction).

---

## Content Normalization (Before Chunking)

Applied universally to all content in `indexing.ts`:

1. Strip HTML tags (letter-prefixed only): `/<\/?\s*[a-zA-Z][^>]*>/g`
2. Decode HTML entities: `&amp;` → `&`, `&lt;` → `<`, etc.
3. Collapse 3+ consecutive newlines → 2 newlines
4. Collapse 2+ spaces → 1 space
5. Trim start/end

Targets Confluence, Zendesk, Gmail which can leak partial HTML tags.

---

## Non-Textual Data — Complete Handling Matrix

| Format | Where It Appears | What Happens |
|--------|-----------------|--------------|
| PDF (text-based) | Drive, SharePoint | `pdf-parse` → clean text |
| PDF (image/scanned) | Drive, SharePoint | Placeholder, or LlamaParse with OCR if `LLAMAPARSE_API_KEY` set |
| DOCX | Drive, SharePoint | `mammoth.extractRawText()` — text only, no table structure |
| XLSX | Drive, SharePoint | ExcelJS → CSV rows, **headers repeated per 200-row chunk** |
| PPTX | SharePoint | LlamaParse if configured, else `[Unsupported file type: .pptx — skipped]` |
| PNG / JPG / images | Anywhere | Always skipped with placeholder |
| ADF (Jira/Confluence) | Jira, Confluence | Recursive descent to plaintext |
| Notion block tree | Notion | Recursive descent to Markdown |
| BI query results | Looker, Tableau, Metabase | CSV rows inline in chunk content |
| SQL table data | Snowflake, BigQuery, Redshift | Stats + sample + aggregation chunks from `bi-chunking.ts` |
| Slack file attachments | Slack | Not fetched |
| Gmail attachments | Gmail | Fetcher exists; **not called in default flow** |
| Code files | GitHub | Not indexed (issues, PRs, wikis only) |
| Embedded images in Notion | Notion | Image blocks return empty string, silently dropped |
| Chart images | Tableau, Looker, Metabase | Not fetched (data rows indexed instead) |

---

## Structural Gaps

### 1. Chunking is source-family-level, not data-shape-level
A 50-column Salesforce record and a 3-field HubSpot contact both get the no-split treatment. A Snowflake table that produces a 4 000-token stats chunk uses the tabular 768-token window — but column groupings that make the stats meaningful can still be split across boundaries.

### 2. Embedding is content-blind
Structured BI content (column stats, aggregations) and unstructured prose (legal briefs, Slack threads) go through the same model with no domain hint. The model handles it, but differentiation that could be encoded upstream is left entirely to the vector space.

### 3. KG extraction has no structural awareness
The LLM extractor sees all `chunk_text` as prose. A stats chunk (`col: revenue, avg: $2.4M, top values: EMEA, APAC`) goes through the same entity extractor as a Jira issue comment — entity extraction on statistical summaries produces noise or nothing useful. The Tier A/B gate on Slack is the right pattern and does not yet exist for BI data.

### 4. No multimodal path
Images embedded in documents (Notion image blocks, PDF figures, Tableau chart PNGs) are silently discarded. There is no vision-model path for extracting meaning from visual content.

### 5. Code is structurally absent
GitHub integration indexes issues, PRs, and wikis but not repository files. Engineering queries about "what does this function do" or "where is X implemented" have no grounded answer.

---

_Files referenced: `lib/integrations/indexing.ts`, `lib/integrations/bi-chunking.ts`, `lib/integrations/tabular-analysis.ts`, `lib/integrations/base.ts`, `lib/integrations/microsoft/document-parser.ts`, `lib/knowledge-graph/modules/registry.ts`, `lib/knowledge-graph/builder.ts`, all connector fetchers under `lib/integrations/`_
