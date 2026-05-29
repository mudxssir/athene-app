export type ReportCadence = "daily" | "weekly" | "monthly" | "custom";

export type SectionQueryType =
  | "synthesis"    // RAG query across all sources
  | "bi_summary"   // BI/analytics query (requires BI integration)
  | "decisions"    // Recent decisions from KG
  | "alerts"       // Unread watchlist alerts
  | "custom";      // Free-form query

export interface ReportSection {
  id: string;
  title: string;
  query: string;
  query_type: SectionQueryType;
  /** If true, section is skipped when no data is found rather than showing "no data" */
  skip_if_empty?: boolean;
  order: number;
}

export interface ReportTemplate {
  id: string;
  org_id: string;
  created_by: string;
  name: string;
  description: string;
  sections: ReportSection[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReportSchedule {
  id: string;
  org_id: string;
  template_id: string;
  created_by: string;
  cadence: ReportCadence;
  cron_expr: string;              // e.g. "0 8 * * 1" = 8am every Monday
  recipients: ReportRecipient[];
  run_as_user_id: string;         // User context for agent queries
  is_active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export interface ReportRecipient {
  type: "user" | "email";
  /** user_id or email address */
  destination: string;
  name?: string;
}

export interface GeneratedReport {
  id: string;
  org_id: string;
  schedule_id: string | null;
  template_id: string;
  title: string;
  sections: GeneratedSection[];
  summary: string;
  generated_at: string;
  generated_by_user_id: string;
}

export interface GeneratedSection {
  id: string;
  title: string;
  content: string;
  cited_sources: SectionSource[];
  status: "ok" | "no_data" | "error";
}

export interface SectionSource {
  document_id: string;
  title: string | null;
  source_type: string;
  external_url?: string | null;
}

