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
| P3-6 | Sidecar `/email/clean` (Talon): reply text embedded; quoted tail + signature → final non-embedded chunk | done | M | P3-5, P1-11 |
| P3-7 | Migration: delete per-slice email documents + paced mailbox re-index; citation links survive | done (script; dry-run default, not run on real data) | S | P3-5 |
| P3-8 | Thread parent rows: synthetic parent per `thread_id` for small-to-big return + cached thread doc-context line | done (parent built; retrieval JOIN + LLM line deferred) | M | P3-5 |
| P3-9 | `text/calendar` parts → record shape routing; attachments → media queue stub | done (Gmail; Outlook attachments deferred) | S | P3-5 |

## Context envelope

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P3-10 | `documents.context_summary` migration + doc-context generator (simple tier, cached by content_hash, injection-guarded, ≤60 tok) | done (migration + generator; wired in P3-13) | M | — |
| P3-11 | Breadcrumb builders per connector: Drive folder_path (exists), Notion ancestor chain, Confluence space+ancestors, SharePoint site/drive | done (builder; ancestor-walk + space-name enrichment deferred) | M | — |
| P3-12 | Per-chunk situating lines: batched 10/call JSON, prose/email/work_item, skip single-chunk docs; `context_header` in embedding-row metadata | done (generator; wired in P3-13) | M | P3-10 |
| P3-13 | Embed text assembly: `header + '\n\n' + child` (one place: indexing pipeline) | done (bulk + single-doc standard; structural+envelope follow-up) | S | P3-10, P3-11, P3-12 |

---

## Defects closed this phase

| Defect | Title | Closed by |
|--------|-------|-----------|
| D4 | Gmail/Outlook emails fragmented into per-slice rows; overlap duplicated | P3-5, P3-6, P3-7 |
| D7 | Drive XLSX bypasses tabular engine; 200-row windows re-split at 512 tok | P3-3 |
| D8 | `normalizeContent` corrupts code-like text (`<T>`, `<Component>`) in all prose | P3-4 |
| D1 (verify) | Decision extraction live for Drive/Gmail/SharePoint/upload (closed by shape in P1; verified here, string sets deleted) | gate suite |
| D12 (partial) | Docling pictures + Gmail attachments → media queue stubs (P5 consumes); Notion images + Outlook attachments deferred | P3-2, P3-9 |

---

## Post-implementation review round (2026-06-13)

A full review against the plan, the to-do lists, the SDLC rules, and regression
cases. Ran the COMPLETE suite (not just the integration subset): 937 TS tests +
21 Python + tsc + check-rls. Findings + fixes:

1. **Doc-context coupled to situating (plan deviation).** `computeChunkHeaders`
   gated BOTH the doc-context line (PLAN_A §0.3 layer 2 — meant to be per
   *document*, all narrative shapes) and situating (layer 3 — prose/email/
   work_item only) behind `shapeGetsSituating`, so records got no doc-context.
   **Fixed:** new `shapeGetsDocContext` (prose/email/thread/work_item/record;
   excludes deterministic tabular/bi_artifact/media which are self-describing).
   Doc-context and situating now run independently. Test added (record shape →
   doc-context applied, situating skipped).
2. **Unbounded LLM fan-out in the bulk path (operational risk / SDLC "don't
   hammer providers").** `Promise.all(changedItems.map(computeChunkHeaders))`
   could issue up to ~2 LLM calls × N documents concurrently (a 200-doc sync →
   ~400 concurrent calls) once `CONTEXT_ENVELOPE` is flipped on a pilot.
   **Fixed:** `mapWithConcurrency` worker pool, `ENVELOPE_CONCURRENCY = 5`
   (order-preserving). Latent until the flag flips, but caught pre-pilot.
3. **Tabular metadata dropped by the Docling adapter (correctness bug).**
   `parsedToChunks` did `c.metadata = stamp(provider, resource_type)` —
   REPLACING the object and dropping the tabular builder's keys (`row_count`,
   `table`, real `resource_type`), which faceted search relies on. The Drive
   (P3-3) and Microsoft paths correctly MERGE. **Fixed:** the tabular branch now
   spreads `...c.metadata` then layers base metadata + parser provenance; the
   prose chunk (freshly built) keeps a full object. Test strengthened to assert
   `resource_type=table_stats`, `row_count`, and merged `folder_path` survive.
4. **Stale test mocks.** Two pre-existing indexing test files mocked
   `feature-flags` without `CONTEXT_ENVELOPE`; the envelope test mocked
   `doc-context`/`situating` without the new shape predicates and with an
   always-true `shapeGetsSituating`. All corrected to mirror real behavior.

Confirmed clean (no change needed): P0-6 chunk-text-store rule (all `chunk_text`
refs in new production files are comments; reads/writes go through the store);
embedding-alignment in the bulk path (allEmbedTexts/allTexts/flatHints flatten in
the same order; late-chunking offsets aligned); content_hash is of RAW text so the
envelope header never affects delta-sync dedup; skip_embedding + structural +
sentinel branch ordering in both indexer paths; thread-parent grouping excludes
`#quoted` provenance and calendar records. The `storage.test.ts` timeout seen in
one full-suite run was parallel-run resource contention (passes in 0.6 s in
isolation on both P2 and P3; imports nothing from the P3 diff) — not a regression.

## Session notes

### P3-13: embed-text assembly — context envelope wired (2026-06-13)

_Context-envelope finale — wires breadcrumb (P3-11) + doc-context (P3-10) +
situating (P3-12) into the indexer's EMBEDDED text. Behind `CONTEXT_ENVELOPE`
(default OFF → zero behavior change; verified by the 432-test suite)._

- **Assembly helpers** (`context-envelope.ts`): `buildContextHeader({breadcrumb,
  docContext, situating})` joins the non-empty layers; `assembleEmbedText(header,
  chunkText)` → `header + '\n\n' + chunkText` (chunk unchanged when header empty).
- **`computeChunkHeaders`** (`indexing.ts`): per document, breadcrumb (free) +
  doc-context (1 LLM call for enrichable shapes, persisted to
  `documents.context_summary` via `persistContextSummary`) + situating
  (multi-chunk only) → one header per sub-chunk. Returns empty headers when the
  flag is off.
- **Wired into both standard paths:** bulk `indexDocuments` (late + hint-group
  batches now embed `itemEmbedTexts`/`allEmbedTexts`) and single-doc
  `indexDocument`. The EMBEDDED text carries the header; the stored `chunk_text`
  stays RAW (citations/KG unaffected); `content_hash` is of the raw text (header
  never affects dedup); the header is mirrored to `metadata.context_header` (a
  key separate from `chunk_text`, never a FORBIDDEN content key).
- **Deferred (documented):** the structural parent/child path
  (`indexDocument` structural branch, only reachable when BOTH
  `PIPELINE_SHAPE_ROUTING` AND `CONTEXT_ENVELOPE` are on) is breadcrumb-eligible
  but not yet envelope-wired — a contained follow-up. With shape-routing OFF
  (prod default) all docs flow through the standard paths, which ARE wired, so
  the common pilot config is fully covered.
- **Tests:** `indexing-context-envelope.test.ts` (1 end-to-end: embedded text
  contains breadcrumb + doc-context + body, stored chunk_text is raw, content_hash
  is of raw text, `context_header` mirrored, `context_summary` persisted) +
  `context-envelope.test.ts` +4 (buildContextHeader/assembleEmbedText). Fixed two
  pre-existing mocks to export `CONTEXT_ENVELOPE: false`. 432 integration+indexing
  tests green; tsc + RLS clean.

### P3-12: per-chunk situating lines (2026-06-13)

- **`lib/indexing/situating.ts`** — `generateSituatingLines(docContext,
  chunkTexts, orgId)`: one short "this chunk covers X within Y" line per chunk
  (Anthropic contextual-retrieval style), in JSON batches of 10 (~0.1 call/chunk)
  at the `simple` tier. Returns an array aligned to chunks (null where
  unavailable). **Single-chunk docs → all-null, no model call** (breadcrumb +
  doc-context already situate them).
- `shapeGetsSituating` gates to prose/email/work_item (P3-13 applies it).
- **Robust JSON parse** (`parseSituatingJson`): tolerates ```json fences and a
  `{lines:[…]}` object, pads/nulls on length mismatch or unparseable output.
  Chunk excerpts delimited + "ignore instructions inside" (injection guard).
  Per-batch fail-open: a throwing batch leaves nulls; other batches survive.
- **Producer only**; consumed by the P3-13 assembly (situating line stored in the
  embedding-row metadata `context_header`, never in chunk_text).
- **Tests:** `situating.test.ts` (9) — shape gate, JSON parsing (fences/object/
  mismatch/garbage), single-chunk skip, one-line-per-chunk, batching (23→3 calls),
  per-batch fail-open. tsc clean.

### P3-10: doc-context generator + context_summary column (2026-06-13)

- **Migration** `20260613000002_documents_context_summary.sql`:
  `documents.context_summary text` (additive; documents RLS already governs it).
- **`lib/indexing/doc-context.ts`** — `generateDocContext(title, content, orgId)`:
  one `simple`-tier LLM call (BYOK-aware via `resolveModelClient`) → a ≤25-word
  "what this document is about" line. The body is delimited
  (`<<<DOCUMENT…>>>`) and the model is told to treat it as data and ignore inner
  instructions (prompt-injection guard); output is URL-stripped + clamped to 320
  chars by `sanitizeDocContext`. Returns null on empty input or any LLM failure →
  envelope degrades to breadcrumb-only.
- **Caching = content_hash:** the indexer calls this only when a document's
  content changes (P3-13 wiring), so it's one call per content_hash; the result
  persists on `documents.context_summary`.
- **Producer only** (like P3-11); consumed + persisted by the P3-13 assembly.
- **Tests:** `doc-context.test.ts` (6) — summary returned, array content blocks,
  empty→null (no model call), throw→null fail-open, injected-URL stripped;
  `sanitizeDocContext` URL/whitespace/length. tsc clean.

### P3-11: deterministic breadcrumb builder (2026-06-13)

_First ticket of the context-envelope group. Order: P3-11 (this, deterministic)
→ P3-10 (doc-context LLM) → P3-12 (situating LLM) → P3-13 (assembly wires all
three into the indexer). All behind `CONTEXT_ENVELOPE` (default OFF)._

- **`lib/indexing/context-envelope.ts`**: pure, zero-cost `buildBreadcrumb(chunk)`
  → `{source} › {container} › {title}` from metadata fetchers already carry.
  `sourceLabel(provider, resource_type)` disambiguates Google→Gmail/Drive/Calendar
  and Microsoft→Outlook/SharePoint/OneDrive; `containerSegment` resolves
  folder_path / space / channel(#) / site / project / repo from known keys and
  degrades to `{source} › {title}` when none is present; `cleanTitle` strips
  connector "Prefix: " noise.
- Consumed at embed-assembly time (P3-13); not wired into the indexer yet (the
  builder is the deliverable here, integration lands with the doc-context +
  situating layers in P3-13).
- **Deferred (documented):** the full Notion ancestor-walk + Confluence
  ancestor/space-NAME enrichment (each needs an extra API walk + cache table).
  The builder reads a pre-built `breadcrumb_path` metadata key when a future
  walk supplies one, and otherwise uses `space_id` — still a valid container
  signal. Tracked as a connector-enrichment follow-up.
- **Tests:** `context-envelope.test.ts` (10) — Drive/Confluence/Slack/SharePoint/
  Notion breadcrumbs, prefix stripping, root-folder skip, `breadcrumb_path`
  preference, unknown-provider capitalization. tsc clean.

### P3-7: per-slice email deletion migration — audit D4 (2026-06-13)

_Email-group finale — sequenced LAST so re-index produces final-form chunks
(after P3-5/6/8/9 all landed)._

- **`scripts/migrations/delete-per-slice-emails.ts`**: deletes the OLD per-slice
  email `documents` rows so the next sync re-indexes under the P3-5 scheme;
  `document_embeddings` cascade-delete (FK ON DELETE CASCADE, verified in schema).
- **DRY-RUN BY DEFAULT** — the script only counts/samples without `--execute`. The
  migration is reversible only by re-index, so "drill on staging first" is
  enforced by the tool, not just discipline. **Not run against any real data in
  this session.** Paginated, paced batched deletes, `--org`-scoped.
- **Corrected the playbook's deletion predicate.** The shorthand
  `external_id LIKE 'gmail:%:%'` is WRONG after P3-8/P3-9: it would also delete
  the new `gmail:{id}:ical:{n}` (calendar) and `gmail:thread:{id}` (thread parent)
  documents. The precise classifier `isOldPerSliceEmailId` matches only
  `^gmail:[^:]+:\d+$` / `^ms_email_[^:]+:\d+$` (old per-slice ends in `:{integer}`
  with a single id segment).
- **Tests:** `per-slice-email-id.test.ts` (5) — matches old `gmail:{id}:{idx}` /
  `ms_email_{id}:{idx}`; rejects the new one-chunk (`gmail:{id}`), calendar
  (`:ical:n`), thread-parent (`:thread:`), and unrelated docs (drive/notion).
  tsc clean.
- **Citation survival:** citations are generated at query time from current docs;
  post-delete + re-index, new docs keep the same `source_url`, so links resolve
  going forward (old `:idx` citations regenerate against the new `gmail:{id}` doc).

### P3-8: synthetic email thread-parent chunks (2026-06-13)

- **Design fork resolved:** the thread parent spans MULTIPLE documents (emails
  sharing a `thread_id`), so it can't use the within-document `parent_chunk_index`
  JOIN (P1-8). Built it as a synthetic non-embedded thread-parent DOCUMENT instead.
- **`buildThreadParentChunks`** (`thread-parent.ts`): groups email message chunks
  by `thread_id`, emits one parent per thread with ≥2 messages
  (`{gmail|ms_email}:thread:{id}`, `skip_embedding: true`, resource_type
  `email_thread`). Content = deterministic digest: subject (Re:/Fwd: stripped),
  unique participants, message count, chronological per-message one-liners
  (windowed at 50 + "… and N earlier"). Re-emitted every sync → refreshes on new
  message (content-hash dedup skips unchanged digests). Filter ignores `#quoted`
  provenance, calendar records, and thread-less messages.
- **Wired:** appended at the end of Gmail `indexEmailChunks` and
  `fetchMicrosoftChunks` (the filter ignores the non-email chunks the MS function
  also accumulates). Stored via the P3-6 `skip_embedding` path (own document,
  embedding=null, excluded from vector search).
- **Deferred (documented):** (1) the retrieval-time child→thread-parent JOIN is a
  `vector_search` RPC change (cross-document, on thread_id) tracked as a P3
  search-layer follow-up — until it lands, the parent is a stored anchor, not yet
  returned; (2) the LLM "what this thread is about" context line is P3-10's
  doc-context generator applied at thread granularity. The deterministic digest is
  the foundation both attach to. Gate-neutral (email gates met by P3-5/P3-6).
- **Tests:** `thread-parent.test.ts` (4: parent per multi-message thread,
  single-message skipped, ignores #quoted/calendar/no-thread, huge-thread
  windowing). 305 integration tests green; tsc + RLS clean.

### P3-9: calendar parts → record + attachment stubs (Gmail) — audit D12 (2026-06-13)

- **Root cause (D12):** the Gmail MIME walk (`extractBodyFromPayload`) only
  returned text/plain | text/html; `text/calendar` parts and binary attachments
  were silently dropped (`fetchGmailAttachment` existed but was never called).
- **Fix:** new `collectEmailParts(payload)` recursive walk gathers calendar part
  bodies + attachment refs (any part with `filename` + `body.attachmentId`).
  `GmailPayloadPart` extended with `filename` + `body.attachmentId`.
  - **Calendar:** `icalToRecordContent` extracts SUMMARY/DTSTART/DTEND/LOCATION/
    ORGANIZER/DESCRIPTION → a `record`-shape chunk (`gmail:{id}:ical:{n}`,
    resource_type `calendar_invite`).
  - **Attachments:** `enqueueMediaStubs(orgId, gmail:{id}, [{ref:attachmentId}],
    'gmail_attachment')` — reuses the P3-2 media_queue path; P5 revives
    `fetchGmailAttachment` to fetch + caption. No silent drop.
- **Deferred (documented):** Outlook email attachment enumeration needs an extra
  per-email Graph `/messages/{id}/attachments` call; Outlook calendar invites
  already arrive as records via the `/me/events` path, so the email-embedded ICS
  case is low-value there. Tracked as a follow-up.
- **Tests:** `google-fetchers.test.ts` +1 — a multipart email with a text/calendar
  part + a PDF attachment yields an email chunk + a `record` calendar chunk
  (`gmail:m-2:ical:0`, content "Event: Quarterly Review"/"Location: Room 4") and
  one `enqueueMediaStubs` call (`gmail_attachment`, ref `att-xyz`). 301
  integration tests green; tsc clean.

### P3-6: Talon email cleaning — `/email/clean` lane (2026-06-13)

- **Sidecar `/email/clean`** (`main.py`): Talon `quotations.extract_from` strips
  the quoted chain → `reply_text`; `signature.extract` (when `sender` known)
  detects the signature. Returns `{ reply_text, signature, quoted_tail,
  stripped_ratio }`. 503 when Talon is unavailable → callers fail open. Lazy
  `_ensure_talon()` init (loads the ML classifier once). `talon==1.4.4` pinned
  (validate at sidecar build). Email bodies never logged (lengths/ratio only).
- **Signature 30% cap** (playbook edge case): a detected signature larger than
  30% of the body is treated as a misdetection (non-Latin script Talon misreads)
  and kept in the reply, not stripped.
- **`cleanEmail()` client** (`sidecar-client.ts`): shares the circuit breaker +
  120 s timeout; returns null on unavailable/error → caller embeds full body.
- **`buildEmailChunks` helper** (`email-clean.ts`, shared by Gmail + Outlook):
  keeps the canonical header verbatim, embeds `header + reply_text`, and emits
  the stripped quoted tail + signature as a dedicated `skip_embedding` provenance
  chunk (`chunk_id {id}#quoted`). Fail-open: no sidecar / empty reply → one chunk
  with the full body.
- **`skip_embedding` indexer support** (`base.ts` + `indexing.ts`): new
  `FetchedChunk.skip_embedding` flag. `writeSkipEmbeddingRow` writes ONE row
  (embedding=null, needs_embedding=false, chunk_text via chunk-text-store,
  excluded from vector search) and prunes stale chunks — mirrors
  `dropSentinelChunk`, handled out-of-band in both `indexDocument` and the bulk
  `indexDocuments` Phase 1 so the embedding-alignment flow is never touched.
- **Why this honors the spec:** storing content in metadata is forbidden
  (FORBIDDEN_METADATA_KEYS), so the tail correctly lives in `chunk_text` of a
  non-embedded chunk, exactly as PLAN_A's email shape requires. Minor deviation:
  the provenance chunk is its own document (`{id}#quoted`) rather than an extra
  chunk_index on the email document — functionally identical (retrievable, never
  embedded) and far lower-risk than threading into the bulk alignment logic.
- **Tests:** Python +5 (`test_main.py`: auth, empty body, 503 degrade, quoted-
  chain strip, 30% signature cap = 21 total); TS `email-clean.test.ts` (4:
  fail-open, reply+provenance split, no-tail, empty-reply fail-open);
  `indexing.test.ts` +2 (skip_embedding writes one embedding=null row, no
  embedBatch, in both paths). 300 integration tests green; tsc + RLS clean.

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
| Email duplicate-text ratio < 2% | mechanism in place (P3-6 embeds reply only, not quoted chain); measurement needs deployed sidecar + pilot org |
| Documents-per-email = 1 | ✅ P3-5 — one chunk per email, `chunk_id` without `:idx` (the `#quoted` provenance row is a deliberate separate non-searchable doc, not a content slice) |
| Prose recall@5 ≥ 20% over P0 baseline | mechanisms in place (context envelope P3-10→13 + structural chunking P1); measurement needs Jina keys + pilot org (same infra blocker as P1/P2 gates) |
| Parser fallback rate < 5% over a week | todo (needs deployed sidecar + telemetry window) |
| D8 regression green (SQL/code fixture survives byte-identical) | ✅ `normalize-content.test.ts` (8 tests) — fenced code byte-identical, inline `<T>`/`<Component>`/SQL operators survive |

**Rollback:** lane flags per connector (`SIDECAR_PARSING` off → P1 inline parsers); context
envelope behind `CONTEXT_ENVELOPE` (off → breadcrumb-only, never blocks); email migration
reversible only by re-index (accepted — drill on staging org first).
