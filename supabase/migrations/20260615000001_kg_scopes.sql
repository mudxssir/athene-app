-- ============================================================
-- P6-1 (PLAN_C §2 / §3.3): hierarchy materialization — scope schema
--
-- The flat KG (kg_nodes/kg_edges) gains a hierarchy of *scopes*
-- (App → Vertical → Department → Org, plus Community and Person) with
-- per-scope membership and bottom-up summaries. Summaries are NOT kg_nodes
-- (that would pollute entity search) — they live in kg_scope_summaries and are
-- read through a dedicated tool.
--
-- All P6 behavior is gated in TS by HIERARCHY_SCOPES (default OFF). These tables
-- + the department lifecycle trigger are pure structural bookkeeping (no LLM, no
-- membership), so they are safe to maintain even while the feature is dormant —
-- when the flag flips, the scope skeleton already exists. The trigger is
-- exception-safe so a scope-sync issue can never block department CRUD.
--
-- RLS model (§2):
--   · app / vertical / org / community scopes — org-visible (structural).
--   · department scopes — readable by admins and members of that department.
--   · person scopes — readable by that person and admins only.
--   · kg_scope_members — visible iff the underlying kg_node is visible (the
--     EXISTS subquery inherits kg_nodes RLS).
--   · kg_scope_summaries — readable iff the scope is readable; the *content*
--     guarantee (summary never quotes above the scope's visibility class) is
--     enforced at generation time by filtering the summarizer's inputs (P6-6).
--
-- org_id is denormalized onto members/summaries (the §2 sketch omitted it) so
-- each table has a cheap org-isolation predicate + index, per the standing
-- "RLS per new table" rule.
-- ============================================================

-- ── 1. kg_scopes ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kg_scopes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  level           text NOT NULL CHECK (level IN ('app','vertical','department','org','community','person')),
  key             text NOT NULL,            -- 'jira' | 'engineering' | dept uuid | 'root' | community id | member uuid
  parent_scope_id uuid REFERENCES kg_scopes(id) ON DELETE SET NULL,
  title           text NOT NULL,
  freshness       timestamptz,              -- last successful refresh
  stale_after     timestamptz,              -- person scopes: now()+7d, bumped on activity
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','rebuilding','stale','torn_down')),
  stats           jsonb NOT NULL DEFAULT '{}',  -- node/edge counts, top entity types, summary_dirty
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, level, key)
);

CREATE INDEX IF NOT EXISTS kg_scopes_parent_idx   ON kg_scopes (org_id, parent_scope_id);
CREATE INDEX IF NOT EXISTS kg_scopes_level_idx     ON kg_scopes (org_id, level);
-- Person-scope TTL sweep (§3.2): find active person scopes past stale_after.
CREATE INDEX IF NOT EXISTS kg_scopes_stale_idx
  ON kg_scopes (stale_after)
  WHERE level = 'person' AND status = 'active';

-- ── 2. kg_scope_members ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kg_scope_members (
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_id uuid NOT NULL REFERENCES kg_scopes(id) ON DELETE CASCADE,
  node_id  uuid NOT NULL REFERENCES kg_nodes(id)  ON DELETE CASCADE,
  weight   real NOT NULL DEFAULT 1,
  PRIMARY KEY (scope_id, node_id)
);

-- Touched-node lookups during incremental maintenance (P6-3) + node-side joins.
CREATE INDEX IF NOT EXISTS kg_scope_members_org_node_idx ON kg_scope_members (org_id, node_id);

-- ── 3. kg_scope_summaries ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kg_scope_summaries (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_id   uuid NOT NULL REFERENCES kg_scopes(id) ON DELETE CASCADE,
  version    int  NOT NULL,
  summary    text NOT NULL,           -- GraphRAG-style community report
  highlights jsonb NOT NULL,          -- key entities, active blockers, decisions, obligations, rating
  input_hash text NOT NULL,           -- hash of member-set + edge-set → skip unchanged
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, version)
);

CREATE INDEX IF NOT EXISTS kg_scope_summaries_org_idx ON kg_scope_summaries (org_id, scope_id);

-- ── 4. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE kg_scopes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_scope_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_scope_summaries ENABLE ROW LEVEL SECURITY;

-- kg_scopes: structural scopes org-visible; dept scopes own-dept; person self+admin.
CREATE POLICY kg_scopes_read ON kg_scopes FOR SELECT
  USING (
    org_id::text = app_setting('org_id')
    AND (
      app_setting('user_role') = 'admin'
      OR level IN ('app','vertical','org','community')
      OR (level = 'department'
          AND app_setting('department_id') != ''
          AND key = app_setting('department_id'))
      -- Person scope (key = org_members.id) readable by that member only. We
      -- resolve via org_members because app_setting('user_id') is the Clerk id on
      -- the member path (see rls_helpers) but the internal id on some admin paths
      -- — matching both is correct and errs narrow (admins already covered above).
      OR (level = 'person'
          AND app_setting('user_id') != ''
          AND EXISTS (
            SELECT 1 FROM org_members m
            WHERE m.org_id = kg_scopes.org_id
              AND m.id::text = kg_scopes.key
              AND (m.clerk_user_id = app_setting('user_id') OR m.id::text = app_setting('user_id'))
          ))
    )
  );

-- kg_scope_members: org isolation + the node must be visible (kg_nodes RLS flows
-- through the EXISTS subquery → membership is not secret if the node is visible).
CREATE POLICY kg_scope_members_read ON kg_scope_members FOR SELECT
  USING (
    org_id::text = app_setting('org_id')
    AND EXISTS (SELECT 1 FROM kg_nodes n WHERE n.id = kg_scope_members.node_id)
  );

-- kg_scope_summaries: org isolation + the scope must be readable (kg_scopes RLS
-- flows through the EXISTS → dept/person restriction is inherited).
CREATE POLICY kg_scope_summaries_read ON kg_scope_summaries FOR SELECT
  USING (
    org_id::text = app_setting('org_id')
    AND EXISTS (SELECT 1 FROM kg_scopes s WHERE s.id = kg_scope_summaries.scope_id)
  );

-- ── 5. Department lifecycle trigger (§3.3) ────────────────────────────────────
-- Keeps an L4 department scope (parented to the org 'root' scope) in sync with the
-- departments table. SECURITY DEFINER so it can write kg_scopes regardless of the
-- caller's RLS; exception-safe so a scope-sync failure never blocks department CRUD.
CREATE OR REPLACE FUNCTION sync_department_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_scope_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Deleted dept → scope torn down; nodes keep their other dept memberships.
    UPDATE kg_scopes SET status = 'torn_down', updated_at = now()
      WHERE org_id = OLD.org_id AND level = 'department' AND key = OLD.id::text;
    RETURN OLD;
  END IF;

  -- Ensure the org root scope exists, then upsert the department scope.
  INSERT INTO kg_scopes (org_id, level, key, title)
    VALUES (NEW.org_id, 'org', 'root', 'Organization')
    ON CONFLICT (org_id, level, key) DO NOTHING;
  SELECT id INTO v_org_scope_id
    FROM kg_scopes WHERE org_id = NEW.org_id AND level = 'org' AND key = 'root';

  INSERT INTO kg_scopes (org_id, level, key, parent_scope_id, title, status)
    VALUES (NEW.org_id, 'department', NEW.id::text, v_org_scope_id, NEW.name, 'active')
    ON CONFLICT (org_id, level, key) DO UPDATE
      SET title           = EXCLUDED.title,
          parent_scope_id = EXCLUDED.parent_scope_id,
          updated_at      = now(),
          -- Re-activate a previously torn-down scope on dept re-create/rename.
          status          = CASE WHEN kg_scopes.status = 'torn_down' THEN 'active'
                                 ELSE kg_scopes.status END;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[sync_department_scope] non-fatal: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_department_scope ON departments;
CREATE TRIGGER trg_sync_department_scope
  AFTER INSERT OR UPDATE OR DELETE ON departments
  FOR EACH ROW EXECUTE FUNCTION sync_department_scope();

-- ── 6. One-time backfill of org + department scopes for existing departments ──
INSERT INTO kg_scopes (org_id, level, key, title)
  SELECT DISTINCT org_id, 'org', 'root', 'Organization' FROM departments
  ON CONFLICT (org_id, level, key) DO NOTHING;

INSERT INTO kg_scopes (org_id, level, key, parent_scope_id, title)
  SELECT d.org_id, 'department', d.id::text,
         (SELECT id FROM kg_scopes o WHERE o.org_id = d.org_id AND o.level = 'org' AND o.key = 'root'),
         d.name
  FROM departments d
  ON CONFLICT (org_id, level, key) DO NOTHING;
