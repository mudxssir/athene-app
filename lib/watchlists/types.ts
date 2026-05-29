export type NotifyChannelType = "in_app" | "email" | "slack";

export interface NotifyChannel {
  type: NotifyChannelType;
  /** Email address (type=email) or Slack channel/user ID (type=slack) */
  destination?: string;
}

export type AlertSeverity = "info" | "warning" | "critical";

export interface Watchlist {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  query: string;
  schedule: string;
  last_run_at: string | null;
  last_answer: string | null;
  last_answer_hash: string | null;
  last_cited_sources: CitedSourceSnapshot[];
  notify_channels: NotifyChannel[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WatchlistAlert {
  id: string;
  watchlist_id: string;
  org_id: string;
  user_id: string;
  previous_answer: string | null;
  new_answer: string;
  change_summary: string;
  severity: AlertSeverity;
  cited_sources: CitedSourceSnapshot[];
  is_read: boolean;
  created_at: string;
}

export interface CitedSourceSnapshot {
  document_id: string;
  title: string | null;
  source_type: string;
  external_url?: string | null;
}

export interface EvaluationResult {
  answer: string;
  cited_sources: CitedSourceSnapshot[];
  /** SHA-256 hex of normalised answer text */
  answer_hash: string;
}

export interface DiffResult {
  changed: boolean;
  severity: AlertSeverity;
  /** One-sentence summary of what changed, written for the alert notification */
  summary: string;
}

/** Context needed to run the LangGraph agent on behalf of a user */
export interface WatchlistRunContext {
  orgId: string;
  userId: string;
  role: string;
  deptId: string | null;
  userTimezone: string;
}
