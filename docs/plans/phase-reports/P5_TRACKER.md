# P5 Tracker — Media Shape (vision captions)

_Sprint-style tracker for Phase 5 of `PHASE_EXECUTION_PLAYBOOK.md`. One row per ticket;
detail blocks below. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p5-media-captions` (off `pipeline/p4-bi-crm-depth`) · Flag: `MEDIA_CAPTIONS` (default OFF) · Started: 2026-06-15_

## Tickets

| ID | Title | Status | Size | Depends on |
|----|-------|--------|------|------------|
| P5-1 | `media-prep.ts` — pure image preprocessing: sha256, format/dimension detect, decorative/animated/oversized/unsupported gate, EXIF/metadata strip | done | M | — |
| P5-2 | `vision-caption.ts` — shape-specific prompt (chart/diagram/photo), `captionImage` (vision tier, injection-guarded, retry→null), `buildCaptionChunk` → prose `[Image in {breadcrumb}]: {caption}` | done | M | P5-1 |
| P5-3 | `media-queue.ts` — claim (race-safe), org-wide SHA dedup, daily budget, terminal transitions, retry bump, queue depth | done | M | — |
| P5-4 | `media-bytes.ts` — parent-context inheritance (connection/visibility/breadcrumb) + origin→bytes resolver (Gmail revived; docling-picture gap recognized) | done | M | P5-3 |
| P5-5 | `caption-worker.ts` drain orchestration + `app/api/worker/caption` route + `caption-drain` cron | done | M | P5-1..4 |
| P5-6 | `MEDIA_CAPTIONS` flag, admin `media-queue` queue-depth surface, tracker, full suite + gate, DePlot side-bench note | done | S | P5-1..5 |

---

## Defects closed this phase

| Defect | Title | Closed by |
|--------|-------|-----------|
| D12 | Silent media drops — images discovered during parsing were enqueued as stubs (P3) but never captioned; every skip/failure path was a silent loss | P5-5 (every outcome → `media_queue` status + reason **and** `sync_skips`; terminal failure → placeholder chunk, never a drop) |

---

## Cross-phase interdependency analysis (blockers found + how they were handled)

P5 is the first phase that **consumes** artifacts produced by an earlier phase
(the `media_queue` stubs written since P3). Three real cross-phase gaps surfaced;
each was fixed or recognized-and-routed (never left as a silent failure):

1. **P3 → P5: `media_queue` carries no `connection_id`.** The P3 stub schema is
   `(org_id, source_doc_id, sha256, origin, bytes_ref, …)` — no connection, dept,
   visibility, or owner. The caption worker needs all four to fetch bytes (auth)
   and to index the caption chunk under the **same** access scope as its parent.
   **Fix (P5-4 `resolveParentContext`):** look the parent up in `documents` by
   `(org_id, external_id = source_doc_id)` and inherit `connection_id`,
   `department_id`, `visibility`, `owner_user_id`, provider, and a breadcrumb.
   This also satisfies the P5 edge protocol *"private-channel files inherit source
   visibility"* — the caption row never widens access (verified by test asserting
   `indexDocument` is called with the parent's `restricted` visibility).

2. **P3 → P5: docling-picture refs are provenance-only, not fetchable.** The P3
   sidecar deliberately returns picture provenance (`"file.pdf:pic1"` + page) and
   **no image bytes** (`_extract_docling_pictures`, comment "We do NOT return image
   data"); the stub stored that ref as `bytes_ref`. So PDF-figure captions can't
   fetch bytes today. **Handled (P5-4):** `resolveMediaBytes` recognizes
   `docling_picture` as `provenance_ref_unfetchable` — a telemetried skip (queue
   reason + `sync_skips`), **not** a silent drop and **not** a hard failure. The
   real close needs the sidecar to emit a fetchable image handle (a one-endpoint
   sidecar follow-up); the resolver is a single dispatch entry away from lighting
   it up. **Gate impact:** the "image-only PDF answers via caption" criterion is
   the one gate item that depends on this sidecar follow-up (infra-gated, batched
   with the other deployed-sidecar measurements) — documented in *Gate to P6*.

3. **P5 deliverable: revive the dormant Gmail attachment fetcher.** Playbook P5-1
   names "revive dead Gmail attachment fetcher". `fetchGmailAttachment` existed but
   had no caller. **Done (P5-4):** the `gmail_attachment` origin resolves bytes via
   `fetchGmailAttachment(connectionId, orgId, messageId, attachmentId)` — message id
   parsed from `gmail:{id}`, attachment id from `bytes_ref`, connection inherited
   from the parent. This is the concrete, end-to-end-working byte source today and
   proves the whole worker against a real provider.

**Forward (P5 → P6) wiring:** caption output is a **plain `prose` chunk**
(`resource_type='media_caption'`), not a separate `media`-shape document. So it
flows through the existing prose path for free — Tier-A KG extraction over the
caption text, context-envelope eligibility, and (P6) hierarchy-summary inclusion —
with no new shape plumbing. This is consistent with PLAN_A Part II's "media caption
inherits parent's extraction pass": the queue item is the `media` shape; its
*output* is prose.

**Deferred origins (recognized, not silently dropped):** `notion_image`,
`slack_file`, `drive_image`, `onedrive_image` → `origin_fetch_unimplemented`. Each
is a single resolver function + map entry; the worker, prep, caption, dedup,
budget, and telemetry machinery already handle them. Tracked as per-connector
byte-fetch follow-ups (same deferral class as P4's HubSpot owner-id / MS calendar).

---

## Session notes

### P5-1: media-prep — pure image preprocessing (2026-06-15)

- **`media-prep.ts`** (dependency-free, fully unit-tested on synthetic buffers):
  `sha256` (dedup key); `detectImage` (format + dimensions from magic bytes for
  PNG/JPEG/GIF/WebP, APNG/animated-GIF/animated-WebP detection); `classifyMedia`
  (ordered gate: empty → decorative `<10 KB` → unsupported format → animated →
  oversized `>20 MB`); `stripExif` (JPEG APP1..APP15/COM strip keeping SOI/JFIF/
  scan data; PNG eXIf/tEXt/zTXt/iTXt chunk strip; gif/webp/unknown pass-through).
- **Why pure TS, no `sharp`/`jimp`:** the repo has **zero** image-processing deps,
  and a native binary complicates the serverless deploy. Vision models downscale
  internally, so pixel-resize is a cost optimization, not correctness — **EXIF
  strip (the privacy requirement) is implemented for real**. True downscale-≤2048px
  is deferred to the sidecar's Pillow lane; until then oversized images are
  skipped-with-reason via `MAX_IMAGE_BYTES`, never sent unbounded.
- **Tests:** `media-prep.test.ts` (16) — sha stability; PNG/JPEG/GIF/WebP detect +
  dims + animation; the 5-way classification gate; JPEG GPS-EXIF removed while scan
  data/JFIF/dims survive; PNG text-chunk removal; gif/unknown pass-through; auto
  format-detect.

### P5-2: vision-caption — prompt + caption chunk (2026-06-15)

- **`vision-caption.ts`** mirrors the P3 doc-context cheap-LLM pattern (injection
  delimiters + output clamp + fail-open): `captionKindForOrigin` (BI→chart,
  figures→diagram, else photo); per-kind prompts (chart = axes/series/trend/
  numbers; diagram = components/flow; photo = one line); `captionImage` sends the
  image as a base64 `image_url` data URL via `resolveModelClient('complex', orgId)`
  (BYOK-aware, vision-capable tier), `temperature 0`, retries (default 2) then
  null; `sanitizeCaption` (collapse whitespace, strip URLs/wrapping quotes, 600-char
  clamp). `buildCaptionChunk` emits `[Image in {breadcrumb}]: {caption}` — the
  `[Image in …]` prefix is the hallucination/provenance guard — with
  `resource_type='media_caption'` (deletable for rollback) and `assertSafeMetadata`.
- **Failure path:** caption=null → same prefix + literal "caption unavailable"
  placeholder (audit D12: never a silent drop; deletable by resource_type).
- **Tests:** `vision-caption.test.ts` (13) — kind routing, mime map, sanitize,
  success + data-URL assembly, empty-retry→null, throw-retry→null, late success,
  content-block array handling, empty-buffer no-call; chunk success/placeholder/
  no-breadcrumb/no-sha.

### P5-3: media-queue — claim, dedup, budget (2026-06-15)

- **`media-queue.ts`** over the P3 `media_queue` table: `claimPendingBatch`
  (select ids → guarded `pending/deferred → processing` update, race-safe);
  `reclaimStaleProcessing` (15-min crashed-worker recovery); `findCaptionBySha`
  (org-wide repeated-logo dedup); `captionsUsedToday` + `hasBudgetRemaining`
  (`DAILY_CAPTION_CAP = 500`/org/UTC-day); `markDone/markDeferred/markSkipped/
  markFailed`; `bumpAttemptAndRequeue` (`MAX_ATTEMPTS = 3`); `listOrgsWithQueuedMedia`
  (cron fan-out); `queueDepth` (admin surface). Service-role + org-scoped, with the
  SERVICE-ROLE JUSTIFICATION comment.
- **Tests:** `media-queue.test.ts` (14) via a thenable supabase fluent-builder
  mock (FIFO of responses) — claim flip + empty + error; reclaim count; sha hit/
  miss/empty-short-circuit; budget count + cap gate + fail-open; the four terminal
  transitions + reason clamp; retry under/at MAX; queue-depth tally.

### P5-4: media-bytes — parent context + origin resolver (2026-06-15)

- **`media-bytes.ts`** — `resolveParentContext` (the P3→P5 connection/visibility
  blocker fix, above) + `resolveMediaBytes` origin dispatch: `gmail_attachment`
  (revived `fetchGmailAttachment`), `docling_picture` →
  `provenance_ref_unfetchable`, others → `origin_fetch_unimplemented`; transient
  (Gmail fetch error) vs terminal classification drives the worker's retry/skip
  decision. `parseGmailMessageId` extracts the id from `gmail:{id}`.
- **Tests:** `media-bytes.test.ts` (11) — parent inherit (incl. breadcrumb from
  folder_path) + title-only fallback + null on missing/no-connection/error;
  gmail id parse; gmail bytes fetch + transient-failure classification; malformed/
  missing ref terminal; docling provenance recognized; other/unknown origins
  unimplemented; no-connection skip.

### P5-5: caption-worker drain + route + cron (2026-06-15)

- **`caption-worker.ts`** `runCaptionDrain(orgId, limit=10)` — the per-org batch
  pipeline: reclaim stale → budget count → claim → per row: inherit ctx → resolve
  bytes → classify → SHA dedup → EXIF strip → caption → index (inheriting parent
  visibility) → mark. Branch outcomes: budget overflow → `deferred`; parent missing
  → retry then skip; transient fetch → retry then placeholder+fail; recognized
  un-fetchable → skip+`sync_skips`; decorative/animated/oversized → skip+`sync_skips`;
  model failure → placeholder+fail. Never throws (per-row isolation; mid-flight rows
  reclaimed as stale). `enqueueCaptionDrain` (per-org deduped) available for targeted
  triggers.
- **Route** `app/api/worker/caption/route.ts` — thin QStash-auth (verify +
  idempotency) wrapper, dormant when `MEDIA_CAPTIONS` off; `{org_id}` → single-org
  drain, `{}` (cron) → bounded fan-out over `listOrgsWithQueuedMedia`.
- **Trigger** — `caption-drain` system cron every 15 min (fan-out body). Chosen over
  per-stub enqueue to avoid the stub-before-parent-indexed race; no sync-path
  surgery. Flag-off → worker no-ops, so flipping `MEDIA_CAPTIONS` is the only
  activation step.
- **Tests:** `caption-worker.test.ts` (10) — happy caption (asserts visibility
  inheritance + EXIF strip), dedup reuse (no model call), decorative skip (no
  index), provenance skip, transient requeue, transient-exhausted placeholder+fail,
  model-fail placeholder, parent-missing retry→skip, budget defer overflow, budget
  zero → no claim.

### P5-6: flag, admin surface, wiring (2026-06-15)

- **`MEDIA_CAPTIONS`** flag added to `feature-flags.ts` (default OFF) — gates the
  worker drain and the enqueue/cron trigger.
- **Admin surface** `GET /api/admin/media-queue` — RLS-respecting (the P3
  `media_queue_admin_read` policy) via `withRLS`, mirroring `/admin/sync-skips`:
  returns depth-by-status + recent skip/fail reasons (D12 audit trail), rate-limited.
- **`caption-drain` cron** registered in `system-crons.ts` (the cron test iterates
  the def list, so it adapts automatically).

### DePlot chart→table side-bench (playbook P5-4) — documented, deferred

Per the A-vs-B verdict (Plan A primary; B is a cost-triggered bench), DePlot
chart→table is a *side-bench promoted only if it beats caption-text retrieval on BI
chart fixtures*. It requires the deployed sidecar + a BI-chart fixture set + Jina
keys to measure — infra-gated, batched with the other pilot measurements. The
caption path already routes BI origins to the chart prompt (`captionKindForOrigin`),
so the default (caption-text) lane is live; DePlot is an optimization to evaluate,
not a blocker.

---

## Post-implementation review round (2026-06-15)

Full review against the codebase, the P5 purpose, the playbook plan/edge-protocols,
and the SDLC rules. Findings + fixes:

1. **Cron fan-out drained inline → `maxDuration` timeout risk (correctness).** The
   no-body cron looped `await runCaptionDrain(org)` over up to 50 orgs in one 300s
   function; once vision calls add up that overruns the budget and leaves orgs
   un-drained. **Fixed:** the cron now **enqueues one per-org drain job** (via
   `enqueueCaptionDrain`, deduped per org), so each org drains inside its own worker
   invocation — the embed-retry-per-document pattern. `MAX_ORGS_PER_TICK` raised to
   200 (enqueue is cheap).
2. **No DLQ on a fatal per-org drain (SDLC queueing standard).** **Fixed:** the
   per-org path now writes a `sync_errors` row (`job_type='caption'`, `document_id`
   NULL — dedups via the `NULLS NOT DISTINCT` constraint) so failures surface on the
   admin sync-health page, matching embed-retry.
3. **RLS gate (caught by `check-rls.mjs`).** Adding `supabaseAdmin` to the worker
   route (for the DLQ) required the SERVICE-ROLE JUSTIFICATION comment **and** an
   allowlist entry — `app/api/worker/caption/route.ts` appended to
   `scripts/rls-allowlist.txt`. Gate green.
4. **Coverage:** added `enqueueCaptionDrain` tests (publishes a deduped/retried
   per-org job; no-ops on empty org) now that the fan-out leans on it.

Confirmed clean (no change): visibility inheritance never widens (test-asserted);
every skip/fail path is telemetried (D12); race-safe claim + stale reclaim; budget
defer-don't-drop; injection-guarded caption prompt; no content in logs; caption
goes through `indexDocument` (chunk-text-store honored). **Accepted trade-offs
(documented):** budget counts dedup-reuses (conservative, never overspends);
oversized images skipped rather than downscaled (sidecar Pillow follow-up);
docling-picture provenance refs skipped pending the sidecar image-handle follow-up.

Suite after fixes: **1062 TS tests pass** (+66 P5); tsc clean; check-rls + check-chunk-text green.

## Gate to P6 (criteria + status)

| Criterion | Status |
|---|---|
| Image-only PDF fixture answers a content question via a caption chunk | mechanism complete end-to-end (queue→bytes→prep→caption→prose chunk indexed under parent visibility); **for docling/PDF figures specifically** needs the sidecar picture-bytes follow-up (cross-phase blocker #2) — infra-gated. Proven today against the Gmail-attachment byte source. |
| Queue drains on pilot within budget | ✅ mechanism: 15-min cron fan-out + `DAILY_CAPTION_CAP` defer-don't-drop; measurement needs the pilot org + deployed sidecar |
| Zero silent media drops (D12 telemetry audit) | ✅ every outcome writes a `media_queue` status + reason and a `sync_skips` row; terminal failure emits a placeholder caption chunk — verified in `caption-worker.test.ts` |

**Verification this phase:** full TS suite **1060 passed (115 files)** (+64 P5
tests, 0 regressions); `tsc --noEmit` clean; `check-rls.mjs` green; `check-chunk-text-store`
green. Python sidecar **not re-run this phase — zero Python changes** (pytest
unavailable in the build shell; the P4-green sidecar suite is untouched). The live
gate numbers (caption recall, queue-drain rate, DePlot bench) are infra-gated and
batched with the P1–P4 pilot measurements in `P3_PILOT_RUNBOOK.md`.

**Rollback:** `MEDIA_CAPTIONS` off → worker no-ops, queue accumulates stubs
harmlessly; caption chunks deletable by `resource_type='media_caption'`; cron is a
no-op ping when the flag is off.
