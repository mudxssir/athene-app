# P2 Tracker — Engineering Group Depth (Jira / Linear / GitHub / Slack)

_Sprint-style tracker for Phase 2 of `PHASE_EXECUTION_PLAYBOOK.md`. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p2-engineering-depth` · Flags: `KG_OWNER_GRAPH` (default OFF) · Started: 2026-06-12_

| ID | Title | Status | Commit |
|----|-------|--------|--------|
| P2-1 | Migration `org_member_identities` + RLS + indexes | done | `3059d0f` |
| P2-2 | StructuredOwner emission: jira/linear/github/zendesk | done | `3059d0f` + review fixes |
| P2-3 | `buildStructuredOwnerGraph()` builder step | done | `3059d0f` + review fixes |
| P2-4 | Identity lookup + auto-claim ingestion replaces email-prefix heuristic | done | `81303cf` + review fixes |
| P2-5 | Visibility split for structured work-graph edges + RLS test | done | `47a9af1` + review fixes |
| P2-6 | GitHub timeline refs, issue work_item, PR review comments + reviewers | done | `6881cee` + review fixes |
| P2-7 | Linear project/cycle PART_OF + work_item shapes | done | `8c5e4a6` |
| P2-8 | Jira ADF placeholders + sprint-absence tolerance | done | `3843155` |
| P2-9 | Slack stable windows (10-reply windows, bot allow-list, short-skip) | done | `f831c59` + review fixes |
| P2-10 | Tier-B chain: regex → sidecar GLiNER confirm → LLM | done | (this commit) |
| P2-11 | Third extraction pass (blocker/obligation prompt) | done | (this commit) |

### P2-11 notes

- `BLOCKER_OBLIGATION_PROMPT` (extractor-prompt.ts): focused rubric — only
  blockers (BLOCKS/BLOCKED_BY), obligations (OBLIGATES/OWNS), and deadline
  risks (RISKS); explicitly excludes general entities/decisions, vague
  intentions, structural-but-not-stuck dependencies, and already-resolved
  blockers. Obligation entities carry `obligation_metadata`
  { due_date, actor, status }.
- Gate: `BLOCKER_OBLIGATION_SOURCE_TYPES` = jira/linear/github/zendesk
  (work_item) + slack — thread chunks only reach the extractor after the
  P2-10 regex→GLiNER gate, so slack here is always a gated thread.
- Third parallel pass in `extractFromChunk`; results merge through the
  existing (org_id, label, entity_type) node dedup and
  (source, target, relation) edge dedup with strongest-provenance wins —
  overlap with the general pass is harmless by construction.
- `obligation_metadata` normalizes to FLAT node.metadata keys
  (due_date / actor / status-lowercased) — exactly the keys
  my-obligations.ts parseDueDate/parseActor/parseStatus already read, so
  extracted obligations surface in My Obligations with due dates without
  any reader change. The flag is per-pass: the general pass cannot attach
  obligation metadata.
- Cost shape: +1 medium-tier LLM call per chunk on the four work_item
  connectors and on gated Slack threads only (prose/email/record/tabular
  unchanged).

### P2-10 notes

- Sidecar `/nlp/gliner` lane: GLiNER zero-shot NER (`urchade/gliner_small-v2.1`,
  overridable via `GLINER_MODEL`), labels person/organization/project,
  lazy-loaded singleton, 50-text/5k-char caps, per-text error isolation,
  503 on model-unavailable (callers fail open). `gliner==0.2.13` pinned.
- `glinerExtract()` in sidecar-client: shares the circuit breaker + 120 s
  timeout; entity text never logged (counts/duration only).
- Chain (`extraction-gate.ts`): `shouldRunExtractionChained` (legacy
  source-type path, builder.ts) and `extractionTierChained` (shape path,
  indexer.ts). Verdicts: regex-negative → B (GLiNER never runs);
  regex-positive + entities → A; regex-positive + no entities → B (false
  positive cut); sidecar down/unconfigured → A (fail open — false positive
  costs one LLM call, false negative loses a decision). ONE sidecar call per
  document, only the signal-matching chunks sent (queueing standard).
- Obligation/ownership verbs added to the regex set (assigned to, taking
  over, owns/owner of, responsible for, action item, due by, follow-up by,
  will handle/pick up). Bare "own" deliberately excluded ("their own").
- **Latent bug fixed in indexer.ts**: the flag-ON gate skipped KG only on
  Tier 'C', so an unpromoted Tier-B thread ran the LLM anyway. Now skips on
  anything !== 'A'.
- Python tests for the new lane (auth, caps, 503 degrade, stub-model entity
  shape, per-text isolation) **executed and passing** (13/13 in a minimal
  venv — fastapi/pydantic/httpx/pytest; gliner/docling lazy-imports stubbed).
  `gliner==0.2.13` verified present on PyPI.

### Closure hardening pass (2026-06-12, P2-10/P2-11 close-out)

- **Inert-pass bug found and fixed**: `lib/langgraph/tools/indexer.ts` built
  `ExtractorChunk[]` WITHOUT `metadata`, so `sourceKey` resolved to "" and
  both the decision pass (P0-1) and the new blocker/obligation pass silently
  never fired for documents indexed through that path (builder.ts threads
  metadata; indexer.ts didn't). Now passes `{ ...metadata, source_type }`.
  Contract pinned by a test using the `source_type` key specifically.
- **Blocker-cycle edge protocol covered** (`blocker-cycle.test.ts`, 5 tests):
  A↔B mutual blocking (cycle through own item — itemIdSet guard), B↔C cycle
  one hop out (self-guard per hop), structural 2-hop depth cap (hop-3 node
  never appears), A→A self-loop dropped, dense 3-node cycle mesh returns
  each blocker exactly once. Directly motivated by P2-11: the blocker pass
  emits BLOCKS/BLOCKED_BY from LLM output, so cyclic graphs WILL occur.

## Post-review fix round (2026-06-12)

A deep review against the playbook found 6 items; all fixed:

1. **Identity table had no ingestion path** (review #1). Added
   `lib/integrations/identity-claim.ts`: at sync time, owners whose
   `provider_email` exactly matches an `org_members.email` get an
   `org_member_identities` row (confidence-1 only; ambiguous matches left
   for the future admin confirm/merge UI). Wired into both `indexDocument`
   and `indexDocuments` as fire-and-forget. `StructuredOwner.provider_email`
   added; emitted by jira (when Atlassian privacy allows), linear (GQL
   `email`), zendesk (user sideload). Heuristic fallbacks in
   my-work/my-obligations now log `[identity] heuristic-fallback hit` —
   the gate metric "0 heuristic hits" is measurable.
2. **Owner-edge visibility inverted vs plan** (review #2). Owner edges and the
   work-item node now INHERIT document visibility ("ownership is org-readable
   only via item"); person nodes stay org_wide for cross-dept dedup; link
   edges (BLOCKS/PART_OF/...) stay org_wide. Visibility-split tests rewritten
   to assert the split including the cross-dept scenario field-level half.
3. **Owner-graph step unflagged** (review #3). Builder step now behind
   `KG_OWNER_GRAPH` (default OFF) per the P2 rollback story.
4. **PR requested reviewers missing** (review #4). `reviewRequests` added to
   the PR GQL; requested reviewers emit WORKS_ON, deduped against assignees.
5. **Slack deviations** (review #5). Replies now grouped in append-only
   windows of 10 (`slack-msg-{ch}-{ts}:r{n}` per playbook) — a new reply
   re-embeds at most the tail window; <10-token messages without replies
   skipped; per-org bot allow-list via `syncConfig.botAllowlist`. Zendesk
   sideloads users so person labels are real names (not `zendesk:12345`)
   and emails feed the auto-claim.
6. **No tracker** (review #6). This file.

## Known deviations / deferred (explicit)

- **Admin identity confirm/merge UI** (item 4): deferred to its own ticket;
  auto-claim covers exact-email (confidence-1) mappings only.
- **ADF @mention resolution via identity table** (item 8): mentions render as
  `attrs.text` (e.g. `@Alice`); table-backed resolution deferred until the
  identity table has production data.
- **`oldest_indexed_ts` per channel + idle-sync backfill walk** (item 9):
  still fixed 30-day lookback; backfill walk deferred to a follow-up ticket.
- **`buildStructuredOwnerGraph` resolution chain** (item 3): creates person
  nodes directly (resolution happens at query time via provider_account_id
  IN-lookup); identity-table → alias-resolver → create-unverified chain and
  the two-account-merge test deferred — depends on populated identity table.
- **Edge protocols not yet covered by tests**: blocker-cycle fixture (A↔B BFS
  caps), deleted-Slack-message tombstone, Linear/Jira weekly reconcile job.
  Tracked for the P2 gate, not silently dropped.

## Gate to P3 (criteria + status)

| Criterion | Status |
|---|---|
| Cross-dept blocker fixture passes as member | field-level half tested; DB-policy integration test pending |
| My Work owner resolution = identity table (0 heuristic hits in logs) | measurable now (fallback log counter); needs pilot-org data |
| Slack re-embed volume per reply ↓ >90% | window scheme in place; measurement needs pilot org |
| work_item golden set ≥10% recall improvement | needs Jina keys + pilot org (same blocker as P1 gate) |
| KG fixture: OWNS edges EXTRACTED/1.0 from all four connectors | unit-tested per connector |
