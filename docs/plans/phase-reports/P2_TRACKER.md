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
| P2-10 | Tier-B chain: regex → sidecar GLiNER confirm → LLM | todo | — |
| P2-11 | Third extraction pass (blocker/obligation prompt) | todo | — |

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
