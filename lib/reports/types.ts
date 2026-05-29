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

// ── Pre-built templates ────────────────────────────────────────

export const BUILT_IN_TEMPLATES: Omit<ReportTemplate, "id" | "org_id" | "created_by" | "created_at" | "updated_at">[] = [
  {
    name: "Weekly Engineering Summary",
    description: "Open issues, blockers, velocity, and key decisions across engineering tools.",
    is_active: true,
    sections: [
      { id: "eng-1", title: "Open Blockers & P0 Issues",       query: "What are the current P0 or critical issues blocking engineering?", query_type: "synthesis", skip_if_empty: false, order: 1 },
      { id: "eng-2", title: "Sprint Progress",                  query: "What work was completed and what is still in progress this sprint?", query_type: "synthesis", skip_if_empty: true, order: 2 },
      { id: "eng-3", title: "Key Engineering Decisions",        query: "What engineering decisions were made this week?", query_type: "decisions", skip_if_empty: true, order: 3 },
      { id: "eng-4", title: "Pipeline & System Health",         query: "Are there any system outages, pipeline failures, or performance issues?", query_type: "synthesis", skip_if_empty: true, order: 4 },
    ],
  },
  {
    name: "Monthly Sales Performance",
    description: "Revenue, pipeline, and deal activity across CRM and BI sources.",
    is_active: true,
    sections: [
      { id: "sales-1", title: "Revenue vs Target",              query: "What is our current revenue performance against this month's target?", query_type: "bi_summary", skip_if_empty: false, order: 1 },
      { id: "sales-2", title: "Pipeline Health",                query: "Summarise the current sales pipeline — stage distribution and at-risk deals.", query_type: "synthesis", skip_if_empty: false, order: 2 },
      { id: "sales-3", title: "Deals Closed / Lost",            query: "Which deals closed or were lost this month, and why?", query_type: "synthesis", skip_if_empty: true, order: 3 },
      { id: "sales-4", title: "Key Sales Decisions",            query: "What major sales or pricing decisions were made this month?", query_type: "decisions", skip_if_empty: true, order: 4 },
    ],
  },
  {
    name: "Executive Weekly Briefing",
    description: "Cross-functional summary for leadership — top signals across all departments.",
    is_active: true,
    sections: [
      { id: "exec-1", title: "Top Risks & Alerts",              query: "What are the most critical risks or issues across the organisation this week?", query_type: "alerts", skip_if_empty: true, order: 1 },
      { id: "exec-2", title: "Strategic Decisions",             query: "What strategic decisions were made or are pending this week?", query_type: "decisions", skip_if_empty: false, order: 2 },
      { id: "exec-3", title: "Cross-Department Updates",        query: "What are the key updates from each department this week?", query_type: "synthesis", skip_if_empty: false, order: 3 },
      { id: "exec-4", title: "Key Metrics",                     query: "What do the latest metrics show across revenue, product, and operations?", query_type: "bi_summary", skip_if_empty: true, order: 4 },
    ],
  },
];
