# PLAN C — Hierarchical Knowledge Graph: App → Vertical → Department → Organization

_2026-06-11. Builds on Plan A Part II (shape-routed extraction, structured_owners, identity
table, org-wide work-graph edges) and Plan B Part II (Leiden, GraphRAG-style community
reports). Locked decisions: **fully materialized** scope layers with summary nodes;
**per-person scopes materialized with a freshness TTL (~1 week), evicted when stale,
query-time views otherwise**._

---

## 1. The hierarchy model

One flat `kg_nodes`/`kg_edges` store remains the **source of truth** — materialization adds
*scopes* (persisted subgraph definitions + memberships + summaries) on top, never a second
copy of entity data. This is the only consistency-safe way to materialize: membership rows
and summaries can always be rebuilt from the base graph; entity facts never live in two
places.

```
L5  ORGANIZATION  ──  one root scope per org
L4  DEPARTMENT    ──  org-structure axis (Engineering dept, Sales dept…)
L3  VERTICAL      ──  domain axis from the module registry (engineering, revops, cs, legal)
L2  APP/CONNECTOR ──  one scope per connected source (jira, slack, salesforce…)
L1  COMMUNITY     ──  Leiden communities *within* L2/L3 scopes (topic clusters)
L0  ENTITIES      ──  kg_nodes / kg_edges (flat, RLS-governed — unchanged)

Cross-cutting, TTL-materialized:  PERSON scopes (active members only)
Cross-cutting, query-time:        TEAM views (Linear team / Jira project / GitHub repo)
```

Two distinct axes deliberately coexist: **vertical** (what domain the knowledge belongs to —
derived from source + module mapping) and **department** (who owns it organizationally —
derived from connection/document `department_id` + member assignments). A Salesforce deal is
vertical=revops; the department axis says whether it's the EMEA or US sales department's.
Collapsing these (V1 mistake) loses both queries.

### 1.1 Scope assignment rules

| Level | Membership rule (deterministic) |
|---|---|
| L2 app | node has ≥1 source document whose `source_type` belongs to the connector; weight = doc count |
| L3 vertical | union of L2 scopes mapped by the module registry's `activating_sources` (`modules/registry.ts`) — a node can hold multiple verticals (a person appears in engineering and revops); weight per vertical |
| L4 department | node `department_ids` (existing column) + for person nodes the identity table's member→dept assignment (authoritative over document-derived) |
| L5 org | all nodes (implicit — no membership rows; summaries only) |
| L1 community | Leiden partition computed within each L2 and L3 scope subgraph |
| person | identity table match (verified) — never fuzzy name match |

Conflict rules: identity-table dept assignment beats document-derived dept for person nodes;
nodes with `metadata.unverified=true` (Plan A) are excluded from person scopes and from
summary prompts (quarantine — prevents a hallucinated "Alex" from polluting roll-ups);
multi-dept nodes appear in every matching L4 scope with per-scope weight.

---

## 2. Schema

```sql
CREATE TABLE kg_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),
  level           text NOT NULL CHECK (level IN ('app','vertical','department','org','community','person')),
  key             text NOT NULL,            -- 'jira' | 'engineering' | dept uuid | 'root' | community id | member uuid
  parent_scope_id uuid REFERENCES kg_scopes(id),
  title           text NOT NULL,
  freshness       timestamptz,              -- last successful refresh
  stale_after     timestamptz,              -- person scopes: now()+7d, bumped on activity
  status          text NOT NULL DEFAULT 'active',  -- active | rebuilding | stale | torn_down
  stats           jsonb NOT NULL DEFAULT '{}',     -- node/edge counts, top entity types
  UNIQUE (org_id, level, key)
);

CREATE TABLE kg_scope_members (
  scope_id   uuid NOT NULL REFERENCES kg_scopes(id) ON DELETE CASCADE,
  node_id    uuid NOT NULL REFERENCES kg_nodes(id)  ON DELETE CASCADE,
  weight     real NOT NULL DEFAULT 1,
  PRIMARY KEY (scope_id, node_id)
);

CREATE TABLE kg_scope_summaries (
  scope_id     uuid NOT NULL REFERENCES kg_scopes(id) ON DELETE CASCADE,
  version      int  NOT NULL,
  summary      text NOT NULL,            -- GraphRAG-style community report
  highlights   jsonb NOT NULL,           -- key entities, active blockers, recent decisions,
                                         -- open obligations, importance rating
  input_hash   text NOT NULL,            -- hash of member-set + edge-set → skip unchanged
  model        text NOT NULL,
  created_at   timestamptz DEFAULT now(),
  PRIMARY KEY (scope_id, version)
);
```

RLS: `kg_scopes`/`kg_scope_summaries` readable when the underlying level is readable —
app/vertical/org scopes are org-visible (summaries are *about* structure, but they may quote
content: summaries inherit the **most restrictive** visibility of any member node summarized;
the summarizer receives only member nodes the scope's visibility class can see — dept scopes
summarize from dept-visible nodes only). Person scopes: readable by the person + admins,
period. `kg_scope_members` follows `kg_nodes` RLS via join (membership is not secret if the
node is visible).

The `parent_scope_id` chain materializes roll-up: community → app → vertical → org;
department scopes parent to org directly (separate axis). Summary nodes are **not** kg_nodes
(V1 of this idea would have polluted entity search with meta-text); they live in
`kg_scope_summaries`, and the briefing/chat retrievers query them through a dedicated tool
(`get_scope_summary(level, key)`), optionally embedding summaries into a separate
`scope_summary` source_type for vector recall — flagged per org.

---

## 3. Materialization machinery

### 3.1 Incremental membership maintenance (every sync batch)

`builder.ts` already knows exactly which nodes/edges each document contributed. After
`upsertGraph`, a new step upserts scope memberships for touched nodes only:

1. app scope of the syncing connection: add/refresh memberships for touched nodes.
2. vertical scopes mapped from that app: same.
3. department scopes: diff `department_ids` of touched nodes.
4. person scopes: if a touched node links (≤1 hop via OWNS/WORKS_ON/BLOCKS/DECIDED_BY)
   to an **active** person scope, mark that scope dirty (refresh queue), and bump its
   `stale_after`.
5. Affected scopes get `summary_dirty=true` (in `stats`); a debounced QStash job
   (15-min coalescing window per scope) recomputes Leiden L1 partitions for dirty app
   scopes and regenerates summaries whose `input_hash` changed.

Cost control even under quality-first: summaries regenerate at most once per debounce
window per scope, and only when input_hash changes; Leiden runs per-app-scope (small
graphs), org-level Leiden weekly or on-demand.

### 3.2 Person scopes — the freshness-TTL design (locked hybrid)

- **Activation:** a person scope materializes when (a) the member logs in, or (b) their
  identity is touched by sync activity (assigned, mentioned as owner, blocker chain).
  Materialization = persist membership rows (their 2-hop work-graph: OWNS/WORKS_ON items,
  blocker chains, obligations, decisions they made) + a personal summary (the §6.3 briefing
  sections become readers of this).
- **Freshness:** `stale_after = greatest(now()+interval '7 days', current)`. Any activity
  bumps it. A daily sweep marks scopes past `stale_after` as `stale` and **deletes their
  membership + summary rows** (cheap to rebuild; staleness must never masquerade as truth).
- **Fallback:** queries against a missing/stale person scope transparently run the
  query-time path (`my-work.ts` BFS — kept, it is the correctness reference) and trigger
  re-materialization in the background. UI never blocks on materialization.
- **Invariant:** person-scope content equals what the query-time path would return at
  refresh time. A nightly canary compares materialized vs. live BFS for N random active
  scopes; drift > threshold pages us (catches membership-maintenance bugs — the classic
  failure mode of materialized graphs).

### 3.3 Lifecycle events

| Event | Handling |
|---|---|
| App connected | create L2 scope; backfill memberships as docs index; create/update vertical scope mapping |
| App disconnected | scope → `torn_down`; memberships kept 30 days (reconnect grace) then cascaded; vertical scopes recompute weights; summaries regenerate minus that app |
| Department created/renamed/deleted | L4 scopes track `departments` table by trigger; deleted dept → scope torn down, nodes keep their other dept memberships |
| Member leaves org | person scope torn down immediately (admin-visible export grace); identity rows kept (history edges remain valid, marked `former_member`) |
| Module (vertical) toggled per org | vertical scope rebuilt from registry mapping; L1 communities recomputed |
| Org offboarding | cascade via org_id FKs (scopes/members/summaries) — verify in delete-org runbook |

### 3.4 Full-rebuild escape hatch

`POST /api/admin/graph/rebuild-scopes` (admin, rate-limited): tears down and rebuilds all
scopes for the org from the flat graph in one paced job. Because materialization is
derivative, this is always safe — it is the recovery answer to every consistency bug, and
it runs automatically after `PIPELINE_VERSION` re-index migrations.

---

## 4. Summaries — GraphRAG-style community reports, adapted

Per scope, the summarizer receives: top-K member nodes by weighted degree (K by level: app
50, vertical 75, dept 75, org 100, community 30, person 40), their descriptions, edge
relations among them (with provenance/confidence), active blockers (BLOCKS edges where
target is open), recent decisions (temporal_metadata), open obligations, and the *child
summaries* (communities feed app summaries; apps feed verticals; verticals + departments
feed org — strict bottom-up map-reduce, never raw chunks at upper levels).

Output schema (per `kg_scope_summaries.highlights`):
`{ overview, key_entities[], active_blockers[{from,to,owner,age}], recent_decisions[],
open_obligations[], cross_scope_links[{other_scope, via_entities[]}], rating: 1-10 }`.

`cross_scope_links` is the cross-team payoff: at vertical/org level the summarizer is
explicitly prompted to name entities that bridge scopes ("API Gateway appears in both the
Jira scope and the Salesforce objections cluster") — these become the briefing's
cross-vertical insights and the answer to "which team is the bottleneck": blocker edges
grouped by the owning team/department of the blocking node, available as a deterministic
query (`blockers_by_scope` view) *and* narrated in summaries.

Guards: summaries are length-capped; member node labels are passed through the
prompt-injection delimiter pattern (Plan A §0.3); summaries never include text from nodes
above the scope's visibility class (§2); regeneration skipped when `input_hash` unchanged.

---

## 5. Cross-team blockers & responsibilities (the product payoff)

With Plan A's foundations (org-wide structured work-graph edges, `structured_owners`,
identity table) plus scopes, these become first-class queries:

1. **Blocker matrix** — `dept × dept` and `team × team` counts of open BLOCKS edges
   (deterministic SQL over org-wide edges + scope memberships), powering a "who waits on
   whom" admin surface and the org summary.
2. **Responsibility ledger** — per person scope: items owned (EXTRACTED), obligations due,
   blockers they are the resolver for (their node is the BLOCKS source's owner). Per dept
   scope: the same aggregated, with unowned-blocker count (blockers whose node has no OWNS
   edge — explicitly surfaced as a gap, not hidden).
3. **Escalation paths** — blocker chains crossing ≥2 dept scopes get
   `highlights.active_blockers[].cross_dept=true`, feeding briefing §6.3 and watchlist
   templates ("alert me when my team's items are blocked by another department").

Edge cases: blocker cycles (A blocks B blocks A — source systems allow it) → cycle-detect in
the matrix view, render as cycle, never infinite-loop the BFS (my-work already bounds to 2
hops; the matrix query uses recursive CTE with depth cap 6 + cycle guard); duplicate person
nodes pre-identity-resolution → scopes use canonical node ids (`canonicalNodeId` from
resolver) only; blockers on items owned by ex-members → surface as unowned with
`former_member` annotation.

---

## 6. Build order within this plan

1. Schema (scopes/members/summaries) + RLS + lifecycle triggers.
2. Membership maintenance step in `builder.ts` + backfill job (app/vertical/dept scopes).
3. Leiden in sidecar (graspologic) + L1 communities per app scope; keep Louvain on flat
   graph until parity verified, then retire it.
4. Summary generation worker (debounced) bottom-up: community → app → vertical/dept → org.
5. Person scopes: activation, TTL sweep, canary, My Work/briefing/obligations read paths
   switch to scope-first with live fallback.
6. Blocker matrix + responsibility ledger views + admin surface; watchlist template.

Acceptance: scope rebuild is idempotent (hash-stable membership sets across two rebuilds);
nightly canary drift = 0 on fixtures; org summary cites only org-visible content for a
member account (RLS test); briefing latency improves (reads summaries instead of N queries);
"who is blocked on whom" returns in <200 ms on the pilot org.
