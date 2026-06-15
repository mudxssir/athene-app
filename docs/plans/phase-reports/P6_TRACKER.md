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
| P6-5 | L1 communities per app scope via existing Louvain (`detectCommunities`); persist `community`-level scopes. **Leiden sidecar lane = infra-gated follow-up** | §3 step 3 | todo | M | P6-3 |
| P6-6 | Summary worker: debounced, bottom-up (community→app→vertical/dept→org), `input_hash` skip, visibility-class inputs, GraphRAG-fork prompt, highlights schema, `get_scope_summary` tool | §4 | todo | L | P6-4, P6-5 |
| P6-7 | Person scopes: activation, 2-hop membership + personal summary, 7-day TTL sweep, live-BFS fallback + background rematerialize, nightly canary; My Work/obligations read scope-first | §3.2 | todo | L | P6-6 |
| P6-8 | Blocker matrix (`blockers_by_scope`, dept×dept recursive CTE depth-6 + cycle guard) + responsibility ledger + unowned-blocker surfacing + admin surface + watchlist template | §5 | todo | M | P6-3 |
| P6-9 | Briefing + chat read scope summaries first (live fallback); `HIERARCHY_SCOPES` wiring; rebuild auto-run post-`PIPELINE_VERSION`; gate measurement | §6.3, §6 | todo | M | P6-6, P6-7, P6-8 |

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

**Next:** P6-5 (Louvain communities) → P6-6 (summaries) → P6-7 (person scopes) →
P6-8 (blocker matrix) → P6-9 (briefing/chat wiring).

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
