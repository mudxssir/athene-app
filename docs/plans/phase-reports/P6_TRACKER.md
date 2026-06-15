# P6 Tracker — Hierarchy Materialization (Plan C, full) — IN PROGRESS

_Phase 6 of `PHASE_EXECUTION_PLAYBOOK.md`, executing `PLAN_C_KG_HIERARCHY.md` §6 build
order. Multi-session phase; foundation (P6-1..P6-3) landed 2026-06-15. One row per ticket;
design/scope/blockers below. Status: `todo | in-progress | review | done | blocked`._
_Branch: `pipeline/p6-hierarchy-scopes` (off `pipeline/p5-media-captions`) · Flag:
`HIERARCHY_SCOPES` (default OFF) · Planned: 2026-06-15_

> **Scale note.** This is the program's largest phase (~2–3 weeks, multi-session). Unlike
> P1–P5 it cannot land in one session; it ships **one build-order step per slice**, each
> flag-gated + tested. One step (Leiden) is sidecar-coupled and built on existing Louvain
> until parity — see *Infra-gated* below.

---

## Tickets (depth-first, Plan C §6 build order)

| ID | Title | Maps | Status | Size | Depends on |
|----|-------|------|--------|------|------------|
| P6-1 | Schema (`kg_scopes`/`kg_scope_members`/`kg_scope_summaries`) + RLS + dept/org lifecycle triggers | §2, §3.3 | **done** | M | — |
| P6-2 | Scope registry + assignment rules: app/vertical/dept/community/person keys, `parent_scope_id` roll-up chain (pure TS, unit-tested) | §1, §1.1 | **done** | S | P6-1 |
| P6-3 | Incremental membership maintenance in `builder.ts` (touched nodes only) + dirty marking | §3.1 | **done** | M | P6-2 |
| P6-4 | Backfill job (paced, resumable, per-org) + rebuild escape hatch `POST /api/admin/graph/rebuild-scopes` | §3.1, §3.4 | **done** | M | P6-3 |
| P6-5 | L1 communities per app scope via Louvain (`louvainPartition`); persist `community`-level scopes. **Leiden sidecar lane = infra-gated follow-up** | §3 step 3 | **done** | M | P6-3 |
| P6-6 | Summary worker: debounced, bottom-up (community→app→vertical/dept→org), `input_hash` skip, visibility-class inputs, GraphRAG-fork prompt, highlights schema, scope-summary reader | §4 | **done** | L | P6-4, P6-5 |
| P6-7 | Person scopes: activation, 2-hop membership + personal summary, 7-day TTL sweep, live-BFS fallback + background rematerialize, nightly canary; My Work/obligations read scope-first | §3.2 | **done** | L | P6-6 |
| P6-8 | Blocker matrix (dept×dept SQL functions + cycle-safe) + responsibility-gap (unowned blockers) + admin surface + watchlist template | §5 | **done** | M | P6-3 |
| P6-9 | `get_scope_summary` chat tool (RLS-respecting, registered); `HIERARCHY_SCOPES` wiring; gate record. Briefing-assembly + agent-flow bind = documented pilot wire | §6.3, §6 | **done** | M | P6-6, P6-7, P6-8 |

_(Splits §6's 6 steps into 9 ship-able, testable tickets — same approach P4/P5 used. P6-5 and
P6-8 can interleave once P6-3 lands.)_

---

## What P6 delivers (the product payoff)

P6 turns the flat KG into a queryable hierarchy (App → Vertical → Department → Org, plus
Community and Person scopes) with bottom-up summaries, so briefing/chat answer from
pre-computed scope summaries instead of N live queries, and "which team is the bottleneck"
becomes a deterministic cross-dept blocker matrix + a narrated org summary. No new audit
defect (D1–D12 close by P7); P6 is the Plan C capability layer that P2/P4 foundations were
built for.

---

## Cross-phase interdependency + blocker analysis

P6 is the **consumer of every prior phase's graph output**. Each step's inputs + the real
blockers to check before/while building:

- **P2 → P6 (primary substrate).** Membership, blocker matrix, and responsibility ledger run
  on P2's org-wide structured edges (`OWNS`/`WORKS_ON`/`BLOCKS`/`REPORTED_BY`) +
  `org_member_identities` + `canonicalNodeId` (dedups duplicate person nodes — §5 edge case).
  **⚠ Blocker to verify (P6-3/P6-8):** those edges are gated behind **`KG_OWNER_GRAPH`** (P2,
  default OFF). The blocker matrix / person scopes are only meaningful when that flag is on for
  the org — P6 readers must degrade gracefully (empty matrix, live-BFS fallback) when it's off,
  and the pilot must enable `KG_OWNER_GRAPH` alongside `HIERARCHY_SCOPES`. Confirmed present:
  `BLOCKS`/`DECIDED_BY`/obligation edges in `structured-links.ts` / `extractor-blocker-pass`.
- **P4 → P6.** Record/CRM edges (`TIED_TO_ACCOUNT`, `OWNS`) + calendar obligations feed
  dept/org scope summaries and the cross-vertical `cross_scope_links` ("API Gateway in both the
  Jira scope and the Salesforce cluster"). Gated behind `KG_CRM_EDGES` — same degrade rule.
- **P5 → P6 (free).** Caption chunks are plain prose → already in the flat graph → become scope
  members with **zero P6 work** (the forward-wiring noted in `P5_TRACKER`). No blocker.
- **P0 → P6.** The summarizer reads member node/chunk text through **`chunk-text-store`** (so
  P7 encryption stays config). **Design rule (§2):** summaries are **NOT** `kg_nodes` — they
  live in `kg_scope_summaries`, queried via `get_scope_summary`, so they never pollute entity
  search.
- **P1 → P6.** Scope **visibility classes** (dept scopes summarize dept-visible nodes only)
  rely on the `department_id` + `visibility` columns P1 established on rows/nodes. The
  summarizer must filter member inputs by the scope's visibility class (§2/§4 guard) — the
  core RLS-correctness test for the gate.
- **Internal: `my-work.ts` is the correctness reference, not a thing to replace.** Person-scope
  materialization must **equal** what the my-work BFS returns at refresh time (§3.2 invariant);
  the nightly canary compares them. P6-7 *wraps* my-work (scope-first + live fallback), never
  rewrites it. Confirmed `my-work.ts` + `my-obligations.ts` exist.
- **Existing Louvain (`detectCommunities`) is the community engine for now.** P6-5 uses it; the
  Leiden upgrade is additive (below).
- **⚠ Verify in P6-1/P6-2:** the `departments` table (for L4 lifecycle triggers) and the
  module/vertical **registry mapping** (app → vertical) — not yet located this pass; confirm
  shape before writing triggers + `scopeKeyFor`.

---

## A-vs-B verdicts in force (from the playbook)

- **Communities:** B (graspologic **Leiden**, hierarchical partitions Plan C needs) for the
  hierarchy; A (graphology **Louvain**, exists) retained on the flat graph **until a parity
  test passes, then retired**. → P6-5 ships on Louvain; Leiden is the infra-gated follow-up.
- **Scope summaries:** **B's GraphRAG report-prompt + rating-schema design, A's runtime.** Fork
  the report prompt into `lib/knowledge-graph/prompts/`; execute via `resolveModelClient`
  (BYOK-aware). **Never run GraphRAG's pipeline.**
- **Identity:** A runtime (identity table + resolver); Splink only as an onboarding backfill
  for orgs >2k historical actors (writes *candidates*, admin-confirm; never auto-merge) — skip
  unless the pilot is large.

---

## Infra-gated (built now on Louvain; lit up later)

**Leiden community detection (P6-5, §6 step 3)** needs a new Python sidecar lane
(`/graph/leiden` via graspologic) + a Louvain-parity test (same fixture: compare modularity +
briefing output) before Louvain is retired. The sidecar can't be deployed/run in this build
environment (zero Python this phase; pytest unavailable in the shell — same constraint as P5's
sidecar-image lane). **Plan:** build the entire scope/summary/blocker pipeline on the existing
`detectCommunities` Louvain so P6 is end-to-end functional; add the Leiden lane + parity test as
a documented follow-up, swapping the community source behind one interface. Mirrors P5's
sidecar-picture deferral — code-complete on the available engine, upgrade is a localized swap.

---

## Gate to P7 (Plan C acceptance list)

| Criterion | How it's met |
|---|---|
| Scope rebuild idempotent (hash-stable membership across two rebuilds) | P6-4 backfill is deterministic on canonical node ids; tested by double-rebuild membership-hash equality |
| Nightly canary drift = 0 on fixtures | P6-7 canary compares materialized person scope vs live my-work BFS on fixtures |
| Org summary cites only org-visible content for a member account (RLS test) | P6-6 visibility-class input filter + P6-1 RLS; member-account RLS test |
| Briefing reads summaries instead of N queries (latency improves) | P6-9 briefing/chat → `get_scope_summary` first with live fallback |
| Dept×dept blocker matrix < 200 ms | P6-8 recursive-CTE view (depth 6 + cycle guard) over indexed edges + memberships |

_Live numbers (canary drift, briefing latency, matrix timing) are pilot/infra-gated and batched
with the P1–P5 measurements in `P3_PILOT_RUNBOOK.md`; the mechanisms + fixture tests land per
ticket._

## Rollback

`HIERARCHY_SCOPES` off → every reader (briefing, chat, My Work, obligations) falls back to the
existing live queries; scopes are **derivative**, so full teardown (the §3.4 rebuild endpoint in
reverse) is always safe. No chunking/embedding change → no re-embed.

---

## Session notes

### Foundation slice — P6-1 / P6-2 / P6-3 (2026-06-15)

- **P6-1** `20260615000001_kg_scopes.sql`: the three tables per §2 (org_id denormalized
  onto members/summaries for clean RLS + indexing). RLS — structural scopes org-visible;
  dept = own-dept; **person = resolved via `org_members` matching BOTH `clerk_user_id`
  and `id`** because `app_setting('user_id')` is the Clerk id on the member path but the
  internal id on some admin paths (errs narrow, admins covered). `kg_scope_members` visible
  iff the node is (EXISTS subquery inherits kg_nodes RLS); summaries gated by scope
  readability (content guarantee enforced at generation in P6-6). Exception-safe
  `sync_department_scope()` trigger (SECURITY DEFINER) keeps dept/org scopes in sync without
  ever blocking department CRUD; one-time backfill of existing dept/org scopes. SQL-only —
  validated on apply at staging/pilot (no local DB; same status as every migration here).
- **P6-2** `scope-registry.ts`: **vertical = the existing `PROVIDER_REGISTRY.category`**
  (productivity/crm/devtools/communication/data) — reused, not reinvented, so a new
  connector inherits its vertical. `appScope`/`verticalScope`/`departmentScope`/
  `communityScope` (key `${provider}#${id}`)/`personScope`, `parentScope` roll-up chain,
  `structuralScopesForNode`. 13 tests.
- **P6-3** `scope-maintenance.ts` + `builder.ts` hook: after `upsertGraph`, upsert the
  touched nodes (joined to ids via `nodeKey`) into their app/vertical/dept scopes, ensuring
  the org→vertical→app skeleton + parent links first; the ON CONFLICT update bumps
  `updated_at` — the dirty signal P6-6 keys on. Behind `HIERARCHY_SCOPES`; non-fatal
  (backfill repairs). Service-role write (SELECT-only RLS) → allowlisted + justified. 6 tests.
- **Verification:** full suite **1081 TS** (+19 P6), 0 regressions; tsc clean; check-rls +
  check-chunk-text green. `builder-tabular-tier-c` flag mock extended with `HIERARCHY_SCOPES`.

### P6-4 — backfill + rebuild escape hatch (2026-06-15)

- Refactored `scope-maintenance.ts` to expose `applyScopeMemberships(orgId, entries[])`
  — a multi-provider core (ensure each scope once via a cache; one membership row per
  (node,scope)). `maintainScopeMemberships` (P6-3) is now a thin wrapper; its 6 tests
  unchanged/green.
- `scope-backfill.ts`: `backfillScopeMembershipsPage(orgId, cursor, limit)` pages
  kg_nodes by id-cursor, resolves each node's provider(s) from `source_documents →
  documents.source_type` (a node spans connectors → can join multiple app scopes),
  and applies memberships. Idempotent → hash-stable across reruns (the §6 acceptance
  criterion). `clearScopeMemberships` (rebuild teardown — drops memberships, keeps the
  stable skeleton). `enqueueScopeBackfill` (deduped per (org,cursor)).
- Worker `app/api/worker/scope-backfill` pages via self re-enqueue (Vercel-timeout
  safe) + sync_errors DLQ. Admin `POST /api/admin/graph/rebuild-scopes` (admin,
  rate-limited 5/h): clear → enqueue backfill. Flag-gated; service-role allowlisted.
- 10 tests (`scope-backfill.test.ts`). Suite 1091 TS; tsc + gates green.

### P6-5 — per-app community scopes (Louvain interim) (2026-06-15)

- Extracted a **pure** `louvainPartition(nodeIds, edges)` into `community.ts` (stable
  lowest-id community ids; existing org-wide `detectCommunities` untouched). 4 tests.
- `community-scopes.ts` `buildCommunityScopes(orgId)`: per app scope, induce the
  subgraph from its members + the org edges (loaded once, filtered in memory), run
  Louvain, and materialize each cluster ≥ `MIN_COMMUNITY_SIZE` (3) as a
  `community`-level kg_scope (parent = app) + memberships. Idempotent (stable keys
  `${provider}#${lowestNodeId}`, PK member upserts) + prunes stale communities →
  hash-stable. 5 tests.
- Wired into the scope-backfill worker's completion (last page → `buildCommunityScopes`).
  Service-role allowlisted.
- **Leiden (infra-gated follow-up):** graspologic `/graph/leiden` sidecar lane +
  modularity/briefing parity test before retiring Louvain — swapping is localized to
  the `louvainPartition` call. The one P6 piece needing the deployed Python sidecar.

### P6-6 — debounced bottom-up summaries (2026-06-15)

- `prompts/scope-summary.ts`: GraphRAG-style report prompt **forked (design only)** —
  injection-delimited entities/relations/blockers/child-reports + the fixed highlights
  JSON schema (overview, key_entities, active_blockers, recent_decisions,
  open_obligations, cross_scope_links, rating); cross-scope nudge at vertical/org.
  `parseScopeHighlights` is robust (plain/fenced/noisy JSON, rating clamp, null guards).
  Executed via `resolveModelClient` — never GraphRAG's pipeline (A-vs-B verdict).
- `scope-summary.ts`: `gatherScopeInputs` (top-K by membership weight per level;
  **visibility filter** — structural scopes drop confidential/restricted, dept scopes
  require dept membership; edges + active blockers among the K; child summaries =
  strict bottom-up rollup; stable `input_hash` over member+edge+child-version sets);
  `summarizeScope` (skip on unchanged hash → else LLM → parse → insert version+1 →
  stamp freshness); `selectDirtyScopes` (touched-after-summary, ordered children-first);
  `loadLatestScopeSummary` reader; deduped `enqueueScopeSummary`.
- Worker `app/api/worker/scope-summary` (bottom-up, capped 25/invocation, re-enqueue
  + DLQ); triggered at backfill completion. Service-role allowlisted.
- 20 tests (prompt/parse 11 + engine 9 incl. the input_hash skip + visibility filter).

### P6-7 — person scopes (TTL + canary) (2026-06-15)

- `person-scope.ts`: `materializePersonScope` rebuilds a member's scope memberships
  from the live **my-work BFS** (run under the member's RLS → visibility-correct,
  equals the live path); `activatePersonScope` (login/sync-touch → deduped enqueue);
  `sweepStalePersonScopes` (daily: past `stale_after` → status `stale` + delete
  member/summary rows); **`canaryCheck`** (Jaccard drift of materialized vs fresh BFS
  for N scopes → alert > 0.2 — the membership-bug guard). Person summaries skip the
  structural visibility filter (members are pre-authorized).
- Worker `app/api/worker/person-scope` (materialize / maintain / cron fan-out) +
  daily `person-scope-sweep` cron. 9 tests.

### P6-8 — cross-team blocker matrix (2026-06-15)

- Migration `20260615000002_blocker_matrix.sql`: SECURITY DEFINER, aggregate-only
  `blocker_dept_matrix(org)` (dept×dept open cross-dept blocker counts; cycle-safe
  1-hop; node depts via `unnest(department_ids)`; open-status filter) +
  `unowned_blocker_count(org)` (the "no owner" gap, surfaced).
- `blocker-matrix.ts`: dept-name-enriched reader + `BLOCKER_WATCHLIST_TEMPLATE` +
  pure `evaluateTeamBlockedWatchlist`. Admin `GET /api/admin/graph/blocker-matrix`. 6 tests.

### P6-9 — get_scope_summary tool + flag + gate (2026-06-15)

- `get-scope-summary.ts`: the §2/§6.3 **dedicated tool** — RLS-respecting (reads via
  `withRLS`, so kg_scopes/kg_scope_summaries policies gate dept/person reads — no
  service role), flag-gated (off → "not enabled" → agent falls back to live tools),
  formats the latest summary (overview + entities + blockers + obligations).
  Registered via the project's `registerTool` convention + re-exported from the tool
  registry. 5 tests.
- **Documented pilot wires (gate-neutral when flag off):** binding the tool into the
  retrieval/synthesis Promise.all and rewiring the morning-briefing assembly to read
  the person/dept/org summary first are live-agent edits that would risk regressions
  in a flag-off feature mid-build — the read mechanism is complete + tested; flipping
  it into the agent flow is the pilot integration. Same for auto-running the rebuild
  endpoint after `PIPELINE_VERSION` migrations (no reindex worker exists today).

---

## Phase complete — full P6 verification (2026-06-15)

All 9 tickets done. Suite **1140 TS tests** (+78 over the P5 baseline of 1062), 0
regressions; tsc clean; check-rls + check-chunk-text green. Two migrations
(`kg_scopes`, `blocker_matrix`) — SQL-only, validated on apply at staging/pilot. All
behind `HIERARCHY_SCOPES` (default OFF).

**End-to-end flow (flag on):** builder maintains scope memberships per sync (P6-3) →
backfill/rebuild materializes them from the flat graph (P6-4) → Louvain clusters each
app into communities (P6-5) → the debounced worker writes bottom-up summaries with
input_hash skip + visibility filtering (P6-6) → person scopes materialize from the
my-work BFS with a drift canary (P6-7) → the dept×dept blocker matrix + unowned-gap
surface (P6-8) → chat reads summaries via get_scope_summary (P6-9).

## SDLC checklist (per ticket, same discipline as P0–P5)

- One branch (`pipeline/p6-hierarchy-scopes`); per-ticket commits with tests; push to
  `personal` only; flag default-OFF.
- New tables → RLS + `check-rls.mjs` extension + tenant-isolation tests (P6-1).
- Every background job (membership backfill, scope-refresh, scope-summary, person-scope-sweep)
  is QStash with `retries:3`, idempotency key (`org:scope:input_hash`), DLQ → `sync_errors`.
- Untrusted content → LLM: summary prompts use the injection-delimiter pattern + output clamps.
- chunk text only via `chunk-text-store`; no content in logs; service-role reads carry the
  SERVICE-ROLE JUSTIFICATION comment.
- Definition of done = to-dos checked + gate criteria measured/recorded in `P6.md` + rollback
  drill once.
