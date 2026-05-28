-- Fix kg_nodes RLS policy: guard against empty department_id cast to uuid
-- app_setting('department_id') returns '' when no dept is set. PostgreSQL
-- does NOT guarantee short-circuit AND evaluation so we use CASE to ensure
-- the ::uuid cast is never attempted on an empty string.

DROP POLICY IF EXISTS kg_nodes_read ON kg_nodes;

CREATE POLICY kg_nodes_read ON kg_nodes FOR SELECT
  USING (
    org_id::text = app_setting('org_id')
    AND (
      app_setting('user_role') = 'admin'

      OR visibility = 'org_wide'

      OR (
        CASE WHEN app_setting('department_id') != ''
          THEN app_setting('department_id')::uuid = ANY(department_ids)
          ELSE false
        END
        AND visibility IN ('department', 'bi_accessible')
      )

      OR (app_setting('user_role') = 'super_user'
          AND visibility != 'confidential'
          AND app_setting('grants') != ''
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(app_setting('grants')::jsonb) AS sg
            WHERE sg->>'scope_type' = 'department'
              AND (sg->>'scope_id')::uuid = ANY(department_ids)
          ))
    )
  );
