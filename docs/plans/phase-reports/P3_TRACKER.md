# P3 Tracker — Docs + Email Group Depth (Drive / Gmail / Notion / Confluence / SharePoint / OneDrive / uploads)

_Sprint-style tracker for Phase 3 of `PHASE_EXECUTION_PLAYBOOK.md`. One row per ticket;
detail blocks below. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p3-docs-email-depth` · Flags: `SIDECAR_PARSING` (default OFF), `CONTEXT_ENVELOPE` (default OFF), org-level `external_parsing_allowed` (LlamaParse opt-in) · Started: 2026-06-13_

## Parsing promotion

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P3-1 | Tiered binary parsing: sidecar `/parse` lane 1 → LlamaParse lane 2 (opt-in) → TS lane 3; `parser_used` stamped | done | M | P1-11 |
| P3-2 | Docling output adapter: markdown+headings → structural chunker; tables → `tabularChunksFromParsed`; pictures → media queue stub | done | M | P3-1 |
| P3-3 | D7: Drive `.xlsx` routes through tabular engine; `extractXlsxText` demoted to lane-3 fallback | done | S | P1 tabular |
| P3-4 | D8: delete global HTML-strip from `normalizeContent`; per-shape converters own sanitization + Gmail HTML-part strip | done | M | — |

## Email rebuild (D4)

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P3-5 | Gmail + Outlook emit ONE chunk per email (full body, canonical header block); `chunk_id` without `:idx`; Outlook `conversationId` → thread_id | done | M | P1 shape |
| P3-6 | Sidecar `/email/clean` (Talon): reply text embedded; quoted tail + signature → final non-embedded chunk | todo | M | P3-5, P1-11 |
| P3-7 | Migration: delete per-slice email documents + paced mailbox re-index; citation links survive | todo | S | P3-5 |
| P3-8 | Thread parent rows: synthetic parent per `thread_id` for small-to-big return + cached thread doc-context line | todo | M | P3-5 |
| P3-9 | `text/calendar` parts → record shape routing; attachments → media queue stub | todo | S | P3-5 |

## Context envelope

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P3-10 | `documents.context_summary` migration + doc-context generator (simple tier, cached by content_hash, injection-guarded, ≤60 tok) | todo | M | — |
| P3-11 | Breadcrumb builders per connector: Drive folder_path (exists), Notion ancestor chain, Confluence space+ancestors, SharePoint site/drive | todo | M | — |
| P3-12 | Per-chunk situating lines: batched 10/call JSON, prose/email/work_item, skip single-chunk docs; `context_header` in embedding-row metadata | todo | M | P3-10 |
| P3-13 | Embed text assembly: `header + '\n\n' + child` (one place: indexing pipeline) | todo | S | P3-10, P3-11, P3-12 |

---

## Defects closed this phase

| Defect | Title | Closed by |
|--------|-------|-----------|
| D4 | Gmail/Outlook emails fragmented into per-slice rows; overlap duplicated | P3-5, P3-6, P3-7 |
| D7 | Drive XLSX bypasses tabular engine; 200-row windows re-split at 512 tok | P3-3 |
| D8 | `normalizeContent` corrupts code-like text (`<T>`, `<Component>`) in all prose | P3-4 |
| D1 (verify) | Decision extraction live for Drive/Gmail/SharePoint/upload (closed by shape in P1; verified here, string sets deleted) | gate suite |
| D12 (partial) | Notion images / attachments dropped silently → media queue stubs (P5 consumes) | P3-2, P3-9 |

---

## Session notes

### P3-5: one chunk per email (Gmail + Outlook) — audit D4 (2026-06-13)

_First ticket of the email-rebuild group. Interdependency order within the group:
P3-5 (this) → P3-6 (Talon clean) → P3-9 (calendar/attachment branch) → P3-8
(thread parents) → **P3-7 migration LAST** (so re-index produces final-form
chunks after all content changes land)._

- **Root cause (D4):** both `indexEmailChunks` (Gmail) and the Outlook loop in
  `microsoft/index.ts` pre-sliced each email into 2000/200 overlapping windows
  with `chunk_id` `gmail:{id}:{idx}` / `ms_email_{id}:{idx}` — one `documents` row
  per slice, overlap text duplicated across rows.
- **Fix:** emit ONE FetchedChunk per email, `chunk_id = gmail:{id}` /
  `ms_email_{id}` (no `:idx`). A single `documents` row now holds the whole
  message; sub-chunking happens at index time (email-shape chunk policy when
  `PIPELINE_SHAPE_ROUTING` on, else the legacy `chunkEmail` char-chunker), giving
  correct chunk_index 0..n within one document instead of N documents.
- **Canonical header block:** From / To / Cc / Subject / Date prepended to the
  body. Gmail: added `cc` to `extractHeaders` + the header type. Outlook: extended
  `OutlookEmail` with `toRecipients`/`ccRecipients`/`conversationId`, a shared
  `OUTLOOK_EMAIL_SELECT` $select (folder query + `fetchUnreadEmails` stay in sync),
  and `formatRecipients` helper.
- **Thread stitching:** Gmail `thread_id` already carried (`full.threadId`);
  Outlook now maps `conversationId` → `metadata.thread_id` (feeds P3-8 thread
  parents). The bodyPreview fallback path also stamps thread_id.
- Removed now-dead per-slice chunk-size constants in both files.
- **Tests:** `google-fetchers.test.ts` +1 — `indexEmailChunks` emits exactly one
  chunk for a >3k-char email, `chunk_id` `gmail:m-1` (no `:idx`), canonical header
  incl. Cc, `thread_id` present, full body retained. 48 google+microsoft tests
  green; tsc clean.

### P3-1 + P3-2: tiered parsing cascade + Docling adapter — foundations & Drive (2026-06-13)

_Commit 1 of 2 for the parsing-promotion group. Foundations + the adapter +
Drive wiring land here; Microsoft (SharePoint/OneDrive) + uploads wiring is
commit 2 (keeps each PR ≤ ~600 lines per the SDLC protocol)._

- **Flags** (`feature-flags.ts`): `SIDECAR_PARSING` (default OFF — when off, every
  connector keeps its current LlamaParse-or-TS behavior unchanged; rollback is the
  flag) and `CONTEXT_ENVELOPE` (default OFF, consumed by P3-10→13).
- **Migration** `20260613000001_p3_parsing_promotion.sql`:
  - `organizations.external_parsing_allowed boolean DEFAULT false` — per-org opt-in
    for LlamaParse (lane 2; bytes leave our boundary). Sidecar (lane 1) and TS
    (lane 3) stay in-boundary so they need no opt-in.
  - `media_queue` table (P5 spec: org_id, source_doc_id, sha256, origin, bytes_ref,
    caption, status, attempts, …) — populated as STUBS from P3 onward (audit D12);
    P5's caption worker consumes it. Admin-read RLS, service-role write (mirrors
    `sync_skips`). `bytes_ref` is a pointer, never raw bytes (no content at rest).
- **Sidecar `/parse` extended** (`services/athene-parse/main.py`): the `ParseResponse`
  now also returns `tables[]` (Docling `export_to_dataframe` → headers/rows) and
  `pictures[]` (synthetic `{filename}:pic{n}` refs + page — NOT bytes). Extraction
  is best-effort: `_extract_docling_tables` / `_extract_docling_pictures` return
  `[]` on any Docling API mismatch so the markdown path never breaks. markitdown /
  plain lanes return empty lists. Tests stub a Docling-shaped doc (no heavy dep).
- **`sidecar-client.ts`**: `ParseResult` gains optional `tables` / `pictures`
  (`SidecarParsedTable` / `SidecarParsedPicture`).
- **`binary-parsing.ts`** (new, the shared cascade + adapter):
  - `parseBinaryTiered(buffer, filename, orgId, tsFallback)` — lane 1 sidecar
    Docling → lane 2 LlamaParse (gated on `orgAllowsExternalParsing`, 5-min cached
    per-org read) → lane 3 the caller's in-process TS parser. Returns unified
    `{ text, tables, pictures, parser_used, parser_version }`.
  - `parsedToChunks(parsed, opts)` — the P3-2 adapter: tables →
    `tabularChunksFromParsed` (Tier C), markdown → one prose FetchedChunk (the
    structural chunker runs downstream in `indexing.ts` on the heading tree),
    pictures → `enqueueMediaStubs` (fire-and-forget). `parser_used`/`parser_version`
    stamped on every chunk.
  - `enqueueMediaStubs` — upserts `media_queue` pending rows (idempotent on
    org/doc/origin/ref); non-fatal.
- **Drive wired** (`drive-fetcher.ts`): `fetchDocumentChunks` gains a
  `tieredParsingEnabled()` branch (after the P3-3 XLSX branch, before the legacy
  LlamaParse path). Lane-3 fallback `driveTsFallback` parses the in-hand buffer
  (extractPdfText/extractDocxText) — no re-download. Unsupported-format text still
  routes to `sync_skips`.
- **Tests:** `binary-parsing.test.ts` (8) — lane selection (sidecar / LlamaParse
  opt-in / TS), opt-in cache, adapter chunk emission + parser stamping + media
  stubs; `test_main.py` +3 (tables/pictures fields, Docling extraction with stub,
  graceful degradation) = 16 Python green. 50 related TS tests green; tsc clean.
### P3-1: Microsoft + uploads wiring (2026-06-13, commit 2 of 2)

- **`parseDocumentEnhanced`** gains `opts?: { orgId?; sourceDocId? }` and returns
  `{ text, tables, parser_used? }`. When `tieredParsingEnabled() && opts.orgId`,
  rich documents (PDF/DOCX/PPTX) route through `parseBinaryTiered`; Docling picture
  refs → `enqueueMediaStubs(orgId, sourceDocId, …)`. Flag OFF → unchanged
  LlamaParse-first behavior. CSV/XLSX/TSV stay on the deterministic
  `parseDocumentStructured` path (no parser needed).
- **Callers threaded:** `fetchDocContent` (SharePoint, sourceDocId
  `ms_sharepoint_${itemId}`), `fetchOneDriveDocContent` (OneDrive,
  `ms_drive_${itemId}`), upload route (`sourceDocId = storagePath`) — each matches
  the chunk_id the indexer builds so media stubs link to the parent document.
- **`parser_used` stamped** onto the prose + tabular chunks built in
  `microsoft/index.ts` (both OneDrive and SharePoint sections) and the upload route.
- Verified: tsc clean, `check-rls.mjs` green (no new `supabaseAdmin` token in
  scanned dirs — the media write lives in `binary-parsing.ts`), 293 integration
  tests green.
- **Remaining (infra-gated, not code):** sidecar must be deployed
  (`SIDECAR_URL`/`SIDECAR_AUTH_TOKEN`) + `SIDECAR_PARSING=true` per pilot org to
  measure the parser-fallback-rate gate; `media_queue` depth surfaced in admin
  sync-health is a small follow-up UI row (data is being written).

### P3-3: D7 — Drive .xlsx routes through the tabular engine (2026-06-13)

- **Root cause (audit D7):** `.xlsx` binaries are not in `LLAMAPARSE_BINARY_TYPES`,
  so `fetchDocumentChunks` fell through to the flat-text fallback
  (`fetchDriveFileContent` → `extractXlsxText` → CSV text in 200-row windows →
  `driveFileToChunk` shape `prose` → re-split at 512 tokens). Spreadsheet column
  structure was destroyed and BI-style queries ("revenue by region") missed.
- **Fix:** new `parseXlsxBufferToTables(buffer)` (the lane-3 TS parse emitting
  `ParsedTable[]`, one per sheet) + a dedicated XLSX branch at the top of
  `fetchDocumentChunks` that routes the in-hand buffer through
  `tabularChunksFromParsed` (provider `google_drive_tabular`) — the SAME engine
  native Google Sheets (`fetchSheetChunks`) and uploads already use. Produces
  stats/sample/agg chunks (Tier C, deterministic, no LLM) with stable chunk_ids
  (`drive:{id}:stats|sample|agg`) for delta-sync idempotency.
- **No re-download:** both sync paths (selected-resources + folder-walk) already
  download the buffer before calling `fetchDocumentChunks`, so the tabular branch
  reuses it.
- **`extractXlsxText` out of the indexing flow (D7 requirement):** the sync flow
  no longer reaches it — degenerate workbooks (no header+data sheet) emit a
  `sync_skips` record ("[Spreadsheet contains no parseable tables]") instead of
  re-routing to prose. `extractXlsxText` + the `fetchDriveFileContent` xlsx branch
  remain only as a defensive string path for any direct caller (there are none
  today); `parseXlsxBufferToTables` is the kept lane-3 TS parse.
- **Tests:** `drive-xlsx-tabular.test.ts` (5) — multi-sheet → one ParsedTable per
  sheet; header-only/empty sheets skipped; blank header cells → `col_N`, all-blank
  rows dropped; corrupt buffer → `[]`; end-to-end xlsx buffer →
  `tabularChunksFromParsed` yields `:stats`/`:sample` chunks with `shape !== prose`.
  24 existing Google fetcher tests green; tsc clean.

### P3-4: D8 — normalizeContent no longer corrupts code-like prose (2026-06-13)

- **Root cause (audit D8):** `normalizeContent` ran on ALL content regardless of
  source and globally stripped any `<…>` that looked like a tag. The P0 hardening
  (letter-prefixed only) reduced but did not eliminate the corruption: `<Component>`,
  `<T>`, `<Foo />` were still turned into spaces in every prose/code chunk.
- **Fix:** removed the HTML-tag-strip regex entirely. HTML sanitization is owned by
  the per-shape converters that actually emit HTML, verified present at the source:
  Confluence `stripHtml` (`confluence-html.ts`), Zendesk `stripHtml`
  (`articles-fetcher.ts`), Outlook `stripOutlookHtml` (`microsoft/index.ts`), Gmail
  `stripHtmlTags` + `extractBodyFromPayload` (prefers `text/plain`, falls back to
  stripped `text/html`). So the playbook's "add Gmail HTML-part strip" was already
  satisfied — no fetcher change needed; the global net was pure liability.
- **Fence-aware residual normalization:** the kept transforms (entity decode +
  whitespace collapse) now run only on prose BETWEEN fenced blocks
  (`normalizeProse`). Fenced code (``` / ~~~) is copied verbatim so
  indentation-significant code (Python/YAML/SQL) survives byte-identical — PLAN_A
  Part I prose note ("normalizeContent must skip fenced blocks"). Unterminated
  fences degrade to prose (never throw).
- **Interpretation note for the gate:** "SQL/code fixture survives byte-identical"
  is satisfied for the realistic case — code inside a markdown fence within a prose
  doc (Notion/Confluence/Drive). Raw *unfenced* SQL still gets prose whitespace
  collapse, but the corrupting operation (tag strip on `<T>`/`<Component>`/`a < b`)
  is gone for all content, fenced or not.
- **`normalizeContentTracked`** (P0-7 strip-ratio guard) kept; comment updated — it
  now only fires on heavy un-stripped markup leaking from a converter, which is the
  residual signal we still want.
- **Tests:** `normalize-content.test.ts` (8) — inline `<Component>`/`<T>`/SQL
  operators survive, fenced block byte-identical, entities preserved inside fences,
  prose entity-decode + whitespace-collapse still work, unterminated-fence
  degradation. All 62 pre-existing indexing tests green (zero regressions); tsc clean.

---

## Gate to P4 (criteria + status)

| Criterion | Status |
|---|---|
| Decision nodes from Drive/Gmail/SharePoint/upload fixtures (D1 closed by shape, string sets deleted) | todo |
| Email duplicate-text ratio < 2% | todo |
| Documents-per-email = 1 | todo |
| Prose recall@5 ≥ 20% over P0 baseline | todo (needs Jina keys + pilot org — same infra blocker as P1/P2 gates) |
| Parser fallback rate < 5% over a week | todo (needs deployed sidecar + telemetry window) |
| D8 regression green (SQL/code fixture survives byte-identical) | ✅ `normalize-content.test.ts` (8 tests) — fenced code byte-identical, inline `<T>`/`<Component>`/SQL operators survive |

**Rollback:** lane flags per connector (`SIDECAR_PARSING` off → P1 inline parsers); context
envelope behind `CONTEXT_ENVELOPE` (off → breadcrumb-only, never blocks); email migration
reversible only by re-index (accepted — drill on staging org first).
