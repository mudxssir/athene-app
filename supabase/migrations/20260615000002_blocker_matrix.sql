-- ============================================================
-- P6-8 (PLAN_C §5): cross-team blocker matrix + responsibility gaps
--
-- Deterministic SQL over the org-wide structured work graph (kg_edges/kg_nodes,
-- built by P2 behind KG_OWNER_GRAPH). Aggregate counts only — no node content
-- leaves these functions, so they are safe to expose to admins and to feed the
-- org summary. SECURITY DEFINER + explicit p_org scoping; the admin route gates
-- the caller to role=admin before invoking.
--
--   · blocker_dept_matrix(org)   — "who waits on whom": dept × dept counts of OPEN
--     cross-dept blockers. An open BLOCKS X→Y means dept(Y) waits on dept(X).
--     Cross-dept only (waiting != blocking); a node's depts come from
--     department_ids (a node can sit in several). Cycle-safe: this is the direct
--     1-hop matrix (no recursion), so blocker cycles A↔B simply appear as two rows.
--   · unowned_blocker_count(org) — OPEN blocking nodes with NO OWNS edge: the
--     "no one owns this blocker" gap, surfaced rather than hidden.
-- ============================================================

CREATE OR REPLACE FUNCTION blocker_dept_matrix(p_org uuid)
RETURNS TABLE (blocking_dept uuid, waiting_dept uuid, open_blockers bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH oriented AS (
    -- BLOCKS X→Y : X blocks Y → dept(Y) waits on dept(X).
    SELECT e.source_node AS blocking_node, e.target_node AS waiting_node
    FROM kg_edges e
    WHERE e.org_id = p_org AND e.relation = 'BLOCKS'
    UNION ALL
    -- BLOCKED_BY / DEPENDS_ON A→B : A waits on B → dept(A) waits on dept(B).
    SELECT e.target_node AS blocking_node, e.source_node AS waiting_node
    FROM kg_edges e
    WHERE e.org_id = p_org AND e.relation IN ('BLOCKED_BY', 'DEPENDS_ON')
  )
  SELECT bd AS blocking_dept, wd AS waiting_dept, count(*) AS open_blockers
  FROM oriented o
  JOIN kg_nodes wn ON wn.id = o.waiting_node AND wn.org_id = p_org
  JOIN kg_nodes bn ON bn.id = o.blocking_node AND bn.org_id = p_org
  CROSS JOIN LATERAL unnest(wn.department_ids) AS wd
  CROSS JOIN LATERAL unnest(bn.department_ids) AS bd
  WHERE wd <> bd                                   -- cross-dept only
    AND lower(coalesce(wn.metadata->>'status', wn.metadata->>'state', '')) NOT IN
        ('done','closed','merged','resolved','cancelled','canceled','completed')
  GROUP BY bd, wd
$$;

COMMENT ON FUNCTION blocker_dept_matrix IS
  'PLAN_C §5: dept×dept counts of open cross-dept blockers (who waits on whom). Aggregate-only.';

CREATE OR REPLACE FUNCTION unowned_blocker_count(p_org uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(DISTINCT bn.id)
  FROM kg_edges e
  JOIN kg_nodes bn ON bn.id = e.source_node AND bn.org_id = p_org
  WHERE e.org_id = p_org
    AND e.relation = 'BLOCKS'
    AND NOT EXISTS (
      SELECT 1 FROM kg_edges o
      WHERE o.org_id = p_org AND o.relation = 'OWNS' AND o.target_node = bn.id
    )
$$;

COMMENT ON FUNCTION unowned_blocker_count IS
  'PLAN_C §5: count of open blocking nodes with no OWNS edge — the unowned-blocker gap.';

GRANT EXECUTE ON FUNCTION blocker_dept_matrix(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION unowned_blocker_count(uuid) TO authenticated, service_role;
