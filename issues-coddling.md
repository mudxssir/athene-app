# Issues Coddling

A running log of known issues, deferred decisions, and things that technically "work" but need a better solution.

---

## [1] XLSX Indexing — Marginal RAG Quality

**Status:** Implemented but suboptimal  
**Files:** `lib/integrations/google/drive-fetcher.ts`

### What's happening
XLSX files are extracted by dumping all sheets as raw CSV using SheetJS. This gets indexed into the vector store like any other document.

### Why it's a problem
The extraction produces output like:
```
=== Sheet: Q3 Revenue ===
Region,Product,Q3 Revenue,YoY Growth
EMEA,Athene Pro,850000,12%
...
```
- **Chunking destroys table context** — a 5000-row sheet splits mid-table; later chunks have no column headers, making them semantically useless
- **Formulas are gone** — calculated totals, pivot summaries, conditional logic all disappear
- **Visual structure lost** — merged cells, multi-row headers, colored sections flatten to noise
- **LLM struggles with raw tabular data** — works if the relevant data lands in one chunk, silently fails if it's split

### What should be done (pick one)
1. **Skip XLSX with a clear message** — tell users to convert to Google Sheets (natively exported via Google's API as CSV with full fidelity), surface the guidance in the UI
2. **Header-aware chunking** — instead of raw CSV dump, prepend column headers to every chunk so each 2000-char block is self-contained and queryable
3. **LLM summarisation for small sheets** — if < 200 rows, pass the whole sheet to an LLM call to produce a prose summary, then index that prose instead of raw CSV

Option 2 is the quickest practical win. Option 3 produces the best RAG quality but adds LLM cost per document.

### Files to change
- `lib/integrations/google/drive-fetcher.ts` — `extractXlsxText()` function (currently returns raw CSV dump)
- Optionally: `app/(dashboard)/admin/integrations/drive-picker-modal.tsx` — warn users when they select `.xlsx` files

---

## [2] Configure Route — Provider Gap (All Non-Drive Browsable Connectors)

**Status:** Broken  
**Files:** `app/api/connections/[id]/configure/route.ts`

### What's happening
`PATCH /api/connections/[id]/configure` only handles 5 providers: `google_drive`, `powerbi`, `snowflake`, `bigquery`, `redshift`. Every other browsable connector falls through to:

```typescript
return NextResponse.json({ error: "Unsupported provider for configuration" }, { status: 400 })
```

This means clicking **"Start Syncing"** in the resource browser for SharePoint, Slack, Notion, HubSpot, or Zendesk silently fails. The selection is never saved to `sync_config` and no sync job is dispatched.

### Affected providers
| Provider | Module | Browse works? | Configure saves? | Sync dispatched? |
|----------|--------|--------------|-----------------|-----------------|
| SharePoint | Legal & Compliance | ✅ | ❌ | ❌ |
| Notion | Legal & Compliance | ✅ | ❌ | ❌ |
| Slack | Engineering | ✅ | ❌ | ❌ |
| HubSpot | RevOps | ⚠️ static list | ❌ | ❌ |
| Zendesk | Customer Success | ⚠️ static list | ❌ | ❌ |

### What should be done
Add a generic handler for the remaining browsable providers. For providers where the "selection" is just a list of resource IDs (not a type-specific config), a single shared block handles them all:

```typescript
// Covers: sharepoint, notion, slack, hubspot, zendesk, and future browsable providers
const BROWSABLE_PROVIDERS = ['sharepoint', 'notion', 'slack', 'hubspot', 'zendesk']
if (BROWSABLE_PROVIDERS.includes(provider)) {
  const resources = selectedResources ?? []
  const syncConfig = {
    mode: resources.length > 0 ? 'selected' : 'all',
    selectedResources: resources,
    lastConfiguredAt: new Date().toISOString(),
  }
  await supabaseAdmin.from('connections').update({
    sync_config: syncConfig,
    department_id: departmentId ?? null,
  }).eq('id', connectionId)
  const { dispatched } = await dispatchSync()
  return NextResponse.json({ success: true, dispatched })
}
```

### Files to change
- `app/api/connections/[id]/configure/route.ts` — add the generic handler before the final 400 fallback

---

## [3] Department_id Scoping — Missing in All Non-Drive Fetchers

**Status:** Silent data leak risk  
**Files:** All fetchers except `lib/integrations/google/drive-fetcher.ts`

### What's happening
The indexing worker passes `departmentId` through the job payload. `drive-fetcher.ts` reads it from the `connections` table and stamps it on every `FetchedChunk`. The indexing pipeline then sets `visibility: 'department'` so the knowledge is scoped to that team.

Every other fetcher (`microsoftFetcher`, Slack, Notion, HubSpot, Zendesk) ignores `department_id` entirely — all documents are indexed as `org_wide` regardless of what the admin configured.

### Why it's a problem
- Admins assign connections to departments in the UI (Legal, Engineering, RevOps, CS)
- The UI faithfully writes `department_id` to the `connections` table
- The fetchers silently discard it → documents are always visible org-wide
- No error; no log; admins have no way to know the scoping isn't working

### What should be done
Each fetcher needs to:
1. Receive `departmentId` from the worker payload (already passed)
2. Read it from `connections.department_id` if not in payload
3. Stamp every returned `FetchedChunk` with `metadata.department_id = departmentId`

### Files to change
- `lib/integrations/microsoft/index.ts` — `microsoftFetcher()`
- `lib/integrations/slack/channels-fetcher.ts` — `fetchSlackChannels()`
- `lib/integrations/notion/pages-fetcher.ts`, `databases-fetcher.ts`
- HubSpot fetcher(s)
- Zendesk fetcher(s)

---

## [4] RevOps Module — HubSpot Browse Is a Static Hardcoded List

**Status:** Misleading UX  
**Module:** RevOps (`salesforce`, `hubspot`)  
**Files:** `lib/integrations/browsing.ts`

### What's happening
HubSpot's browse implementation returns a hardcoded static list of resource types — `contacts`, `companies`, `deals`, `notes` — without making any API call to HubSpot. The user sees a list that looks like their real data but is entirely fabricated.

### Why it's a problem
- Users believe they are selecting specific pipelines or lists, but they are just selecting object types that the fetcher would index regardless
- The selection is never saved anyway (Issue [2] — configure route gap)
- Real HubSpot orgs often have custom objects, multiple pipelines, and thousands of records — the static list gives no scope control

### What should be done
Two paths:
1. **Remove the picker for HubSpot** — treat it like Gmail/Salesforce (non-browsable), always sync all supported object types. Removes false precision.
2. **Real browse via HubSpot API** — call `/crm/v3/objects/` to list object schemas + pipeline counts. Gives genuine scope control.

Option 1 is safe and honest. Option 2 requires HubSpot API scopes to be validated.

### Files to change
- `lib/integrations/browsing.ts` — HubSpot browse handler
- `lib/integrations/providers.ts` — possibly mark HubSpot as non-browsable until real browse is implemented

---

## [5] Customer Success Module — Zendesk Browse Is a Static Hardcoded List

**Status:** Misleading UX  
**Module:** Customer Success (`zendesk`)  
**Files:** `lib/integrations/browsing.ts`

### What's happening
Same pattern as HubSpot (Issue [4]). Zendesk's browse returns a static list of `tickets` and `articles` without any API call. No scope control is possible.

### Why it's a problem
- Zendesk orgs typically have multiple brands, ticket forms, and Help Center categories
- The static list implies granular selection but provides none
- Selection is never saved (Issue [2])

### What should be done
1. **Remove the picker** — mark as non-browsable, always sync all Zendesk tickets + articles
2. **Real browse** — call Zendesk REST API (`/api/v2/ticket_forms`, `/api/v2/help_center/categories`) to give real scope control

Option 1 is the honest short-term fix.

### Files to change
- `lib/integrations/browsing.ts` — Zendesk browse handler
- `lib/integrations/providers.ts` — possibly mark Zendesk as non-browsable

---

## [6] Engineering Module — Slack Indexes Only Public Channels; Bot Messages Included

**Status:** Partial data, noise risk  
**Module:** Engineering (Slack via `activating_sources`)  
**Files:** `lib/integrations/slack/channels-fetcher.ts`

### What's happening
The Slack fetcher only discovers and indexes `public_channel` type channels. Private channels are invisible to the fetcher even if the bot has been added to them. Additionally, all message types are indexed including bot messages (CI notifications, Jira updates, automated alerts, etc.).

### Why it's a problem
- Engineering teams commonly use private channels for on-call, incident response, and architecture decisions — precisely the knowledge worth indexing
- Bot messages (Sentry alerts, GitHub PR notifications, Datadog pings) are high-volume and low-semantic-value; they dilute RAG results and burn vector store quota
- No channel filtering is supported via configure route (Issue [2]) so there's no way for admins to opt specific channels in/out

### What should be done
1. **Filter bot messages at ingestion time** — skip messages where `subtype === 'bot_message'` or `bot_id` is set. Quick win, no API change required.
2. **Private channels** — requires the Slack app to have `channels:history` + `groups:history` scopes and to be added to each private channel. Add `groups.list` call alongside `conversations.list` and let admins select channels in the picker.
3. **Wire channel selection** — once configure route handles Slack (Issue [2]), admins can pick channels in the browse UI.

### Files to change
- `lib/integrations/slack/channels-fetcher.ts` — filter `subtype === 'bot_message'` during message ingestion
- `lib/integrations/browsing.ts` — add private channel listing once scopes permit

---

## [7] Legal & Compliance Module — SharePoint Document Parser Indexes Binary Garbage

**Status:** Active bug — corrupts vector store  
**Module:** Legal & Compliance (`google_drive`, `sharepoint`, `notion`)  
**Files:** `lib/integrations/microsoft/document-parser.ts`

### What's happening
SharePoint's document parser handles `.docx` and `.xlsx` correctly, but all other file types fall through to:

```typescript
// Fallback — catches .pptx, images (.png/.jpg), .zip, CSV etc.
return buffer.toString('utf-8')
```

For binary formats (PPTX, images, ZIP), `buffer.toString('utf-8')` produces multi-kilobyte strings of null bytes and garbled control characters. This content is chunked and embedded into the vector store as if it were real text.

### Why it's a problem
- Binary garbage gets embedded → the vectors don't represent any real concept → RAG similarity search returns irrelevant results
- `.pptx` is extremely common in SharePoint — sales decks, legal briefs, HR slides all indexed as noise
- No error is raised; the pipeline thinks it succeeded
- Hard to detect post-hoc without inspecting stored content directly

### Affected file types
| Type | Handled | Current behaviour |
|------|---------|------------------|
| `.docx` | ✅ | mammoth → clean text |
| `.xlsx` | ✅ | ExcelJS → CSV text |
| `.pptx` | ❌ | `buffer.toString('utf-8')` → binary garbage |
| `.csv` | ⚠️ | `buffer.toString('utf-8')` — happens to work, but fragile |
| images | ❌ | `buffer.toString('utf-8')` → binary garbage |
| `.zip` | ❌ | `buffer.toString('utf-8')` → binary garbage |

### What should be done
1. **Immediate fix** — replace the catch-all fallback with an explicit skip:
   ```typescript
   // Instead of: return buffer.toString('utf-8')
   return `[Unsupported file type: ${ext} — skipped]`
   ```
2. **PPTX extraction** — use Microsoft Graph API export endpoint (`/drive/items/{id}/content?format=pdf`) to convert PPTX → PDF server-side, then run `extractPdfText()` on the result
3. **CSV** — guard separately: if extension is `.csv` or `.tsv`, `buffer.toString('utf-8')` is correct

### Files to change
- `lib/integrations/microsoft/document-parser.ts` — replace catch-all fallback with explicit type switch + skip sentinel

---

## [8] Legal & Compliance Module — Notion Browse Works But Configure Save Fails

**Status:** Broken UX (fix blocked on Issue [2])  
**Module:** Legal & Compliance (`google_drive`, `sharepoint`, `notion`)  
**Files:** `app/api/connections/[id]/configure/route.ts`

### What's happening
Unlike HubSpot and Zendesk (Issues [4] and [5]), the Notion browse implementation actually queries the Notion API and returns real pages and databases. The user can browse their real Notion workspace and select items. But the configure route doesn't handle the `notion` provider — the save call returns a 400 "Unsupported provider" error and nothing is persisted.

`pages-fetcher.ts` and `databases-fetcher.ts` do correctly respect `selectedIds` from `sync_config` — so once the configure route gap is fixed (Issue [2]), Notion selection would work end-to-end with no further changes needed.

### What should be done
Fix Issue [2] (add generic configure handler for browsable providers). Notion requires no additional provider-specific logic.

### Files to change
- `app/api/connections/[id]/configure/route.ts` — covered by Issue [2] fix

---

# Second Connector Audit — Next 5 Per Department

## RevOps Module (`salesforce`, `hubspot`)

---

## [9] RevOps — Salesforce Fetchers Ignore syncConfig (All Records Always Synced)

**Status:** Silent scope failure  
**Module:** RevOps (`salesforce`, `hubspot`)  
**Files:** `lib/integrations/salesforce/accounts-fetcher.ts`, `opportunities-fetcher.ts`, `cases-fetcher.ts`

### What's happening
Salesforce is in `BROWSABLE_PROVIDERS` and the browse UI allows selecting accounts, opportunities, and cases. However all three Salesforce fetchers (`accountsFetcher`, `opportunitiesFetcher`, `casesFetcher`) ignore `syncConfig` entirely — they always fetch **every record in the org** via open SOQL queries with no `WHERE` filtering. The user's resource selection in the UI has zero effect on what gets indexed.

Additionally, there is no `contacts-fetcher.ts` — the provider registry lists Contacts as an available resource type, but no fetcher exists for it.

### Why it's a problem
- Large Salesforce orgs (100k+ accounts, 500k+ opportunities) get fully indexed every sync — expensive and slow
- Users cannot scope RevOps to a specific pipeline, region, or deal stage
- Contacts are shown in the provider's resource list but never indexed — silently missing from RAG
- Browsable flag + configure route gap (Issue [2] applied `GENERIC_BROWSABLE` which includes the pattern, but Salesforce was not explicitly added) means "Start Syncing" still works, but the selection is written to `sync_config` and then ignored by the fetcher

### What should be done
1. **Add syncConfig filtering to each Salesforce fetcher** — after extracting `selectedIds`, add a `WHERE Id IN ('a','b',...)` clause to SOQL. For `mode: 'all'`, keep current behaviour.
2. **Add a Contacts fetcher** — `fetchSalesforceContacts()` mirroring the existing pattern (SOQL on `Contact` object)
3. **Add Salesforce to `GENERIC_BROWSABLE`** in configure route (or a dedicated Salesforce handler) so `sync_config` is actually saved

### Files to change
- `lib/integrations/salesforce/accounts-fetcher.ts`, `opportunities-fetcher.ts`, `cases-fetcher.ts` — add syncConfig parameter + SOQL WHERE filtering
- `lib/integrations/salesforce/contacts-fetcher.ts` — create new file
- `app/api/connections/[id]/configure/route.ts` — add `'salesforce'` to `GENERIC_BROWSABLE`

---

## Engineering Module (`github`, `linear`, `jira`, `pagerduty`)

---

## [10] Engineering — Configure Route Missing for All Dev Tools (GitHub, Jira, Confluence, Linear)

**Status:** Broken — selections never saved  
**Module:** Engineering (`github`, `linear`, `jira`)  
**Files:** `app/api/connections/[id]/configure/route.ts`

### What's happening
Just like Issue [2] for the previous connector batch, GitHub, Jira, Confluence, and Linear are all browsable (they have real browse implementations) but are not in the configure route's `GENERIC_BROWSABLE` list. Clicking "Start Syncing" in the resource picker returns 400 "Unsupported provider".

Unlike HubSpot and Zendesk (which were removed from `BROWSABLE_PROVIDERS` because their browse was fake), these four providers have *real* browse implementations that fetch live data from GitHub, Jira, etc. Their selections should be saved.

### SyncConfig fetch-time support (what's already wired correctly)
| Provider | Fetcher respects syncConfig |
|----------|---------------------------|
| GitHub | ✅ Yes (handled in nango-fetch worker wrapper) |
| Jira | ✅ Yes (JQL `project IN (...)` clause) |
| Confluence | ✅ Yes (space-id query param) |
| Linear | ⚠️ Partial (issues: ✅, cycles/projects: ❌ always all) |

The fetchers work — the only gap is saving the selection.

### What should be done
Add `'github'`, `'jira'`, `'confluence'`, `'linear'` to `GENERIC_BROWSABLE` in the configure route. No other changes needed — each fetcher already reads `sync_config.selectedResources` correctly from the worker.

### Files to change
- `app/api/connections/[id]/configure/route.ts` — extend `GENERIC_BROWSABLE` array

---

## [11] Engineering — Jira Comments and Linear Cycles Not Indexed

**Status:** Missing data  
**Module:** Engineering  
**Files:** `lib/integrations/atlassian/jira-fetcher.ts`, `lib/integrations/linear/cycles-fetcher.ts`, `lib/integrations/linear/projects-fetcher.ts`

### What's happening
**Jira:** Only issue fields are indexed (summary, description, status, assignee, priority, sprint). Comments — which often contain the most useful debugging context, architectural decisions, and resolution notes — are never fetched. The comment thread on a Jira ticket is frequently richer than the description.

**Linear:** `linearCyclesFetcher()` and `linearProjectsFetcher()` do not accept `syncConfig` and always sync all cycles and projects regardless of which teams the user selected. A user who selects "Team A" in the picker still gets cycles and projects from Teams B and C indexed.

### Why it's a problem
- Jira: "Why did we make this decision?" and "How was this resolved?" live in comments, not descriptions — RAG misses the most valuable engineering knowledge
- Linear: Cross-team data leaks into scoped syncs; large organisations index hundreds of cycles and projects they didn't want

### What should be done
1. **Jira:** After fetching issues, paginate through `GET /rest/api/3/issue/{key}/comment` for each issue and append comment bodies to the chunk content
2. **Linear cycles/projects:** Pass `syncConfig` to `linearCyclesFetcher` and `linearProjectsFetcher`; filter to cycles/projects that belong to selected team IDs

### Files to change
- `lib/integrations/atlassian/jira-fetcher.ts` — fetch and append comments to each issue chunk
- `lib/integrations/linear/cycles-fetcher.ts`, `projects-fetcher.ts` — add syncConfig + team filtering

---

## [12] Engineering — PagerDuty Listed in Module Registry But Integration Doesn't Exist

**Status:** Broken registry reference  
**Module:** Engineering  
**Files:** `lib/knowledge-graph/modules/registry.ts`

### What's happening
The Engineering module's `activating_sources` includes `pagerduty`, but there is no PagerDuty integration anywhere in the codebase — no fetcher, no provider config, no Nango connection. The module knowledge graph extracts `incident`, `runbook`, and `on_call_rotation` entities assuming PagerDuty data exists; it never does.

### What should be done
Either:
1. **Remove `pagerduty` from `activating_sources`** until the integration is built — prevents the module from activating on phantom data
2. **Build the integration** — PagerDuty has a REST API for incidents and on-call schedules; a fetcher could pull incident titles, descriptions, runbook links, and timeline into the knowledge graph

Option 1 is the immediate honest fix. Option 2 is genuinely useful for Engineering teams.

### Files to change
- `lib/knowledge-graph/modules/registry.ts` — remove `pagerduty` from Engineering activating_sources

---

## Legal & Compliance Module (`google_drive`, `sharepoint`, `notion`)

---

## [13] Legal & Compliance — OneDrive Has No syncConfig Support and No Configure Route Handler

**Status:** Always indexes everything  
**Module:** Legal & Compliance (OneDrive overlaps with SharePoint in the Microsoft stack)  
**Files:** `lib/integrations/microsoft/onedrive-fetcher.ts`, `app/api/connections/[id]/configure/route.ts`

### What's happening
The OneDrive fetcher recursively indexes all files from the user's OneDrive root. Unlike SharePoint (which has a hierarchical browser for sites → drives → folders), OneDrive has no `syncConfig` parameter — no folder-level filtering is possible. Additionally, OneDrive is not in the configure route (not explicitly listed and not in `GENERIC_BROWSABLE`), so clicking "Start Syncing" in the picker fails with 400.

The browse UI for OneDrive does work (folder tree), but the selection is never saved and the fetcher would ignore it even if it were.

### What should be done
1. Add `'onedrive'` to `GENERIC_BROWSABLE` in the configure route so selections can be saved
2. Add `syncConfig` parameter to the OneDrive fetcher and filter by `selectedIds` (item IDs from the browse) before recursing into folders

### Files to change
- `app/api/connections/[id]/configure/route.ts` — add `'onedrive'` to `GENERIC_BROWSABLE`
- `lib/integrations/microsoft/onedrive-fetcher.ts` — add syncConfig + folder ID filtering

---

## BI & Analytics / Data Warehouse

---

## [14] BI Connectors — Tableau Indexes Only Metadata, No Worksheet Data

**Status:** Low RAG value  
**Files:** `lib/integrations/tableau/workbooks-fetcher.ts`

### What's happening
The Tableau fetcher indexes workbook and view metadata only — names, descriptions, project names. No actual worksheet data, measure values, field definitions, or calculated fields are fetched. A Tableau workbook called "Q3 Revenue by Region" is indexed with just its title and description; the actual data it visualises (regions, revenue figures, field names) is not present.

Compare to Looker (which runs the underlying queries and indexes up to 50 sample rows) or Snowflake (which indexes column stats and sample data). Tableau RAG results are semantically near-useless — the user can find a workbook by name but cannot ask "what does the Revenue by Region workbook show for EMEA?"

Additionally, the Tableau fetcher has no configure route handler, so workbook selections made in the browse UI are never saved.

### What should be done
1. **Add `'tableau'` to `GENERIC_BROWSABLE`** in the configure route
2. **Fetch view image or CSV** — Tableau's REST API supports downloading view CSV export via `GET /sites/{siteId}/views/{viewId}/data.csv`. Parsing this CSV and appending it to the chunk would dramatically improve RAG quality
3. **Fetch field metadata** — `GET /sites/{siteId}/datasources/{id}` returns field names, types, and descriptions — useful even without data

### Files to change
- `app/api/connections/[id]/configure/route.ts` — add `'tableau'` to `GENERIC_BROWSABLE`
- `lib/integrations/tableau/workbooks-fetcher.ts` — optionally add CSV export fetch

---

## [15] BI Connectors — Looker, Metabase Have No Configure Route Handler

**Status:** Broken — selections never saved  
**Files:** `app/api/connections/[id]/configure/route.ts`

### What's happening
Both Looker and Metabase have real browse implementations that query their APIs and return actual looks/dashboards/cards. Their fetchers both correctly respect `syncConfig.selectedResources`. But neither is in the configure route, so "Start Syncing" returns 400 and no selection is ever saved.

Looker additionally does not index Explores — the core BI abstraction that analysts use to build reports. Only Looks (saved queries) and Dashboard titles are indexed. An analyst asking "what dimensions are available in the Sales explore?" gets no answer.

### What should be done
1. **Add `'looker'` and `'metabase'` to `GENERIC_BROWSABLE`** — immediate fix, no fetcher changes needed
2. **Looker explores** — `GET /api/4.0/lookml_models` returns all LookML models and their explores with field definitions. Indexing explore/field metadata gives analysts genuine discoverability

### Files to change
- `app/api/connections/[id]/configure/route.ts` — add `'looker'`, `'metabase'` to `GENERIC_BROWSABLE`
- `lib/integrations/looker/looks-fetcher.ts` — optionally add explore/model indexing

---

## [16] Data Warehouses — Large Table Stat Queries Risk Timeouts and Cost Overruns

**Status:** Latent risk  
**Files:** `lib/integrations/snowflake/sample-fetcher.ts`, `lib/integrations/bigquery/datasets-fetcher.ts`, `lib/integrations/redshift/tables-fetcher.ts`

### What's happening
All three data warehouse fetchers run `GROUP BY` aggregation queries to collect categorical column statistics (top-N distinct values per column). For wide tables or tables with high-cardinality string columns, these queries can:
- Scan the entire table
- Run for minutes or hours
- Consume significant query credits (Snowflake credits, BigQuery slot-hours, Redshift WLM slots)

The queries are run synchronously inside the nango-fetch worker — a timeout kills the whole sync job, not just the offending table.

Additionally:
- **BigQuery** has no delta/incremental sync — every sync re-scans all tables from scratch
- **Redshift** auto-discovers all tables if the allowlist is empty instead of failing safely — can accidentally index sensitive production tables

### Why it's a problem
- Snowflake/BigQuery customers on pay-per-query pricing get unexpected bills from sync jobs
- A single 500M-row table with a string categorical column can run for 30+ minutes
- Redshift's auto-discovery is a security risk: if a user connects without configuring an allowlist, the first sync indexes everything including sensitive PII tables

### What should be done
1. **Replace full GROUP BY with TABLESAMPLE** — `SELECT DISTINCT col FROM table TABLESAMPLE SYSTEM (1)` gives approximate top values in milliseconds instead of minutes
2. **Add hard query timeout** — set `STATEMENT_TIMEOUT` (Redshift/PG) or `query_timeout` (BigQuery) on every stat query; fail individual table gracefully, continue with others
3. **Require allowlist** — for Redshift specifically, return an error if allowlist is empty rather than auto-discovering all tables
4. **BigQuery incremental sync** — store `last_modified` per table from `INFORMATION_SCHEMA.PARTITIONS` and skip tables that haven't changed

### Files to change
- `lib/integrations/snowflake/sample-fetcher.ts` — add TABLESAMPLE to categorical stat queries
- `lib/integrations/bigquery/datasets-fetcher.ts` — same + add `last_modified` delta tracking
- `lib/integrations/redshift/tables-fetcher.ts` — require non-empty allowlist; add TABLESAMPLE

---


