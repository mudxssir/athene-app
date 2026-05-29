-- Scheduled reports: templates, schedules, and generated output.

CREATE TABLE IF NOT EXISTS report_templates (
  id           uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid    NOT NULL,
  created_by   uuid    NOT NULL,
  name         text    NOT NULL,
  description  text    NOT NULL DEFAULT '',
  sections     jsonb   NOT NULL DEFAULT '[]',
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_schedules (
  id                 uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid    NOT NULL,
  template_id        uuid    NOT NULL REFERENCES report_templates(id) ON DELETE CASCADE,
  created_by         uuid    NOT NULL,
  cadence            text    NOT NULL DEFAULT 'weekly'
                             CHECK (cadence IN ('daily','weekly','monthly','custom')),
  cron_expr          text    NOT NULL DEFAULT '0 8 * * 1',
  recipients         jsonb   NOT NULL DEFAULT '[]',
  run_as_user_id     uuid    NOT NULL,
  is_active          boolean NOT NULL DEFAULT true,
  last_run_at        timestamptz,
  next_run_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS generated_reports (
  id                     uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid    NOT NULL,
  schedule_id            uuid    REFERENCES report_schedules(id) ON DELETE SET NULL,
  template_id            uuid    NOT NULL,
  title                  text    NOT NULL,
  sections               jsonb   NOT NULL DEFAULT '[]',
  summary                text    NOT NULL DEFAULT '',
  generated_at           timestamptz NOT NULL DEFAULT now(),
  generated_by_user_id   uuid    NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS report_templates_org_id_idx   ON report_templates (org_id);
CREATE INDEX IF NOT EXISTS report_schedules_org_id_idx   ON report_schedules (org_id);
CREATE INDEX IF NOT EXISTS report_schedules_active_idx   ON report_schedules (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS generated_reports_org_idx     ON generated_reports (org_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS generated_reports_schedule    ON generated_reports (schedule_id);

-- Updated_at triggers
CREATE OR REPLACE FUNCTION update_report_tables_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS report_templates_updated_at ON report_templates;
CREATE TRIGGER report_templates_updated_at
  BEFORE UPDATE ON report_templates
  FOR EACH ROW EXECUTE FUNCTION update_report_tables_updated_at();

DROP TRIGGER IF EXISTS report_schedules_updated_at ON report_schedules;
CREATE TRIGGER report_schedules_updated_at
  BEFORE UPDATE ON report_schedules
  FOR EACH ROW EXECUTE FUNCTION update_report_tables_updated_at();

-- RLS
ALTER TABLE report_templates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE generated_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "report_templates_org_select" ON report_templates FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.user_id = auth.uid()
      AND org_members.org_id  = report_templates.org_id
  ));

CREATE POLICY "report_templates_admin_write" ON report_templates FOR ALL
  USING (EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.user_id = auth.uid()
      AND org_members.org_id  = report_templates.org_id
      AND org_members.role IN ('admin', 'super_user')
  ));

CREATE POLICY "report_schedules_org_select" ON report_schedules FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.user_id = auth.uid()
      AND org_members.org_id  = report_schedules.org_id
  ));

CREATE POLICY "report_schedules_admin_write" ON report_schedules FOR ALL
  USING (EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.user_id = auth.uid()
      AND org_members.org_id  = report_schedules.org_id
      AND org_members.role IN ('admin', 'super_user')
  ));

CREATE POLICY "generated_reports_org_select" ON generated_reports FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM org_members
    WHERE org_members.user_id = auth.uid()
      AND org_members.org_id  = generated_reports.org_id
  ));
