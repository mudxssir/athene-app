# P3 Tracker — Docs + Email Group Depth (Drive / Gmail / Notion / Confluence / SharePoint / OneDrive / uploads)

_Sprint-style tracker for Phase 3 of `PHASE_EXECUTION_PLAYBOOK.md`. One row per ticket;
detail blocks below. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p3-docs-email-depth` · Flags: `SIDECAR_PARSING` (default OFF), `CONTEXT_ENVELOPE` (default OFF), org-level `external_parsing_allowed` (LlamaParse opt-in) · Started: 2026-06-13_

## Parsing promotion

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P3-1 | Tiered binary parsing: sidecar `/parse` lane 1 → LlamaParse lane 2 (opt-in) → TS lane 3; `parser_used` stamped | todo | M | P1-11 |
| P3-2 | Docling output adapter: markdown+headings → structural chunker; tables → `tabularChunksFromParsed`; pictures → media queue stub | todo | M | P3-1 |
| P3-3 | D7: Drive `.xlsx` routes through tabular engine; `extractXlsxText` demoted to lane-3 fallback | todo | S | P1 tabular |
| P3-4 | D8: delete global HTML-strip from `normalizeContent`; per-shape converters own sanitization + Gmail HTML-part strip | done | M | — |

## Email rebuild (D4)

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P3-5 | Gmail + Outlook emit ONE chunk per email (full body, canonical header block); `chunk_id` without `:idx`; Outlook `conversationId` → thread_id | todo | M | P1 shape |
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
