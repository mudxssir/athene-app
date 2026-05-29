#!/usr/bin/env tsx
/**
 * scripts/seed-demo.ts
 *
 * Seeds a rich "Meridian Labs" demo dataset into your Athene org.
 * Covers: Slack, Jira, GitHub, Snowflake, Google Drive — 28 documents,
 * knowledge graph (20 nodes, 16 edges, 15 events), 4 watchlists,
 * 2 triggered alerts, and a pre-generated briefing.
 *
 * Usage:
 *   npx tsx scripts/seed-demo.ts
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JINA_API_KEY
 *
 * Optional env:
 *   DEMO_ORG_ID — Supabase org UUID to seed into (auto-detected if omitted)
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL        = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const JINA_API_KEY         = process.env.JINA_API_KEY ?? "";
const REAL_CLERK_USER_ID   = "user_3DghfV8knOaC724syP31F8SiYlA";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("❌  Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ─── Stable IDs (idempotent re-runs) ─────────────────────────────────────────
const D = {
  depts: {
    engineering: "d3000000-0000-0000-0001-000000000001",
    product:     "d3000000-0000-0000-0001-000000000002",
    sales:       "d3000000-0000-0000-0001-000000000003",
    operations:  "d3000000-0000-0000-0001-000000000004",
    executive:   "d3000000-0000-0000-0001-000000000005",
  },
  conns: {
    slack:     "d3000000-0000-0000-0002-000000000001",
    jira:      "d3000000-0000-0000-0002-000000000002",
    github:    "d3000000-0000-0000-0002-000000000003",
    snowflake: "d3000000-0000-0000-0002-000000000004",
    gdrive:    "d3000000-0000-0000-0002-000000000005",
  },
  docs: {
    slack_p0:         "d3000000-0000-0000-0003-000000000001",
    slack_auth:       "d3000000-0000-0000-0003-000000000002",
    slack_smartsync:  "d3000000-0000-0000-0003-000000000003",
    slack_emea:       "d3000000-0000-0000-0003-000000000004",
    slack_pricing:    "d3000000-0000-0000-0003-000000000005",
    slack_snowflake:  "d3000000-0000-0000-0003-000000000006",
    slack_feedback:   "d3000000-0000-0000-0003-000000000007",
    slack_board:      "d3000000-0000-0000-0003-000000000008",
    jira_p0:          "d3000000-0000-0000-0003-000000000011",
    jira_auth:        "d3000000-0000-0000-0003-000000000012",
    jira_smartsync:   "d3000000-0000-0000-0003-000000000013",
    jira_billing:     "d3000000-0000-0000-0003-000000000014",
    jira_soc2:        "d3000000-0000-0000-0003-000000000015",
    jira_emea_bug:    "d3000000-0000-0000-0003-000000000016",
    jira_sso:         "d3000000-0000-0000-0003-000000000017",
    github_hotfix:    "d3000000-0000-0000-0003-000000000021",
    github_auth_v2:   "d3000000-0000-0000-0003-000000000022",
    github_smartsync: "d3000000-0000-0000-0003-000000000023",
    github_snowflake: "d3000000-0000-0000-0003-000000000024",
    snow_revenue:     "d3000000-0000-0000-0003-000000000031",
    snow_emea:        "d3000000-0000-0000-0003-000000000032",
    snow_usage:       "d3000000-0000-0000-0003-000000000033",
    snow_nps:         "d3000000-0000-0000-0003-000000000034",
    gdrive_roadmap:   "d3000000-0000-0000-0003-000000000041",
    gdrive_pricing:   "d3000000-0000-0000-0003-000000000042",
    gdrive_smartsync: "d3000000-0000-0000-0003-000000000043",
    gdrive_board:     "d3000000-0000-0000-0003-000000000044",
    gdrive_emea:      "d3000000-0000-0000-0003-000000000045",
  },
  kg: {
    n_smartsync:   "d3000000-0000-0000-0004-000000000001",
    n_auth_v2:     "d3000000-0000-0000-0004-000000000002",
    n_payment_svc: "d3000000-0000-0000-0004-000000000003",
    n_emea_pipe:   "d3000000-0000-0000-0004-000000000004",
    n_pricing:     "d3000000-0000-0000-0004-000000000005",
    n_snowflake:   "d3000000-0000-0000-0004-000000000006",
    n_soc2:        "d3000000-0000-0000-0004-000000000007",
    n_launch:      "d3000000-0000-0000-0004-000000000008",
    n_techcorp:    "d3000000-0000-0000-0004-000000000009",
    n_sarah:       "d3000000-0000-0000-0004-000000000010",
    n_alex:        "d3000000-0000-0000-0004-000000000011",
    n_priya:       "d3000000-0000-0000-0004-000000000012",
    n_marcus:      "d3000000-0000-0000-0004-000000000013",
    n_eng_team:    "d3000000-0000-0000-0004-000000000014",
    n_sales_team:  "d3000000-0000-0000-0004-000000000015",
    n_mer847:      "d3000000-0000-0000-0004-000000000016",
    n_sync_engine: "d3000000-0000-0000-0004-000000000017",
    n_dbt:         "d3000000-0000-0000-0004-000000000018",
    n_sso:         "d3000000-0000-0000-0004-000000000019",
    n_board:       "d3000000-0000-0000-0004-000000000020",
    e1:  "d3000000-0000-0000-0005-000000000001",
    e2:  "d3000000-0000-0000-0005-000000000002",
    e3:  "d3000000-0000-0000-0005-000000000003",
    e4:  "d3000000-0000-0000-0005-000000000004",
    e5:  "d3000000-0000-0000-0005-000000000005",
    e6:  "d3000000-0000-0000-0005-000000000006",
    e7:  "d3000000-0000-0000-0005-000000000007",
    e8:  "d3000000-0000-0000-0005-000000000008",
    e9:  "d3000000-0000-0000-0005-000000000009",
    e10: "d3000000-0000-0000-0005-000000000010",
    e11: "d3000000-0000-0000-0005-000000000011",
    e12: "d3000000-0000-0000-0005-000000000012",
    e13: "d3000000-0000-0000-0005-000000000013",
    e14: "d3000000-0000-0000-0005-000000000014",
    e15: "d3000000-0000-0000-0005-000000000015",
    e16: "d3000000-0000-0000-0005-000000000016",
    ev1:  "d3000000-0000-0000-0006-000000000001",
    ev2:  "d3000000-0000-0000-0006-000000000002",
    ev3:  "d3000000-0000-0000-0006-000000000003",
    ev4:  "d3000000-0000-0000-0006-000000000004",
    ev5:  "d3000000-0000-0000-0006-000000000005",
    ev6:  "d3000000-0000-0000-0006-000000000006",
    ev7:  "d3000000-0000-0000-0006-000000000007",
    ev8:  "d3000000-0000-0000-0006-000000000008",
    ev9:  "d3000000-0000-0000-0006-000000000009",
    ev10: "d3000000-0000-0000-0006-000000000010",
    ev11: "d3000000-0000-0000-0006-000000000011",
    ev12: "d3000000-0000-0000-0006-000000000012",
    ev13: "d3000000-0000-0000-0006-000000000013",
    ev14: "d3000000-0000-0000-0006-000000000014",
    ev15: "d3000000-0000-0000-0006-000000000015",
  },
  watchlists: {
    emea:       "d3000000-0000-0000-0007-000000000001",
    auth:       "d3000000-0000-0000-0007-000000000002",
    smartsync:  "d3000000-0000-0000-0007-000000000003",
    eng_health: "d3000000-0000-0000-0007-000000000004",
  },
  alerts: {
    emea: "d3000000-0000-0000-0008-000000000001",
    auth: "d3000000-0000-0000-0008-000000000002",
  },
  briefing:   "d3000000-0000-0000-0009-000000000001",
  automation: "d3000000-0000-0000-0009-000000000002",
};

// ─── Document definitions ─────────────────────────────────────────────────────
interface DemoDoc {
  id: string;
  connId: string;
  sourceType: string;
  title: string;
  externalId: string;
  dept: string | null;
  visibility: string;
  preview: string;       // ≤200 chars, shown in UI
  fullText: string;      // used for embedding generation
  externalUrl: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

const DOCS: DemoDoc[] = [
  // ── SLACK (8) ───────────────────────────────────────────────────────────────
  {
    id: D.docs.slack_p0,
    connId: D.conns.slack,
    sourceType: "slack",
    title: "#engineering — P0 Payment Incident May 20",
    externalId: "slack-msg-p0-mer847",
    dept: D.depts.engineering,
    visibility: "department",
    externalUrl: "https://meridian.slack.com/archives/C_ENG/p1716213600",
    createdAt: "2026-05-20T14:30:00Z",
    preview: "P0: Payment service p99 latency 8.2s at 14:23 UTC. PostgreSQL connection pool exhaustion post-deploy v2.4.1. Pool max 20→50. Resolved 14:58 UTC. 847 checkout failures. Post-mortem May 24.",
    fullText: "URGENT P0 — Payment service p99 latency spiked to 8.2 seconds at 14:23 UTC Tuesday May 20. All customers affected during checkout. Root cause: PostgreSQL connection pool exhaustion following deploy v2.4.1 at 14:15 UTC. Pool max was 20, causing exhaustion under concurrent load from new database queries added in v2.4.1. Fix applied: pool.max increased from 20 to 50, connectionTimeoutMillis reduced to 3 seconds. Deployed at 14:58 UTC. Incident resolved. 847 checkout transaction failures recorded. Post-mortem scheduled May 24 owned by Alex Kumar and backend team.",
    metadata: { channel: "#engineering", author: "alex-kumar", incident_id: "MER-847" },
  },
  {
    id: D.docs.slack_auth,
    connId: D.conns.slack,
    sourceType: "slack",
    title: "#engineering — Auth v2 Blocking SmartSync Launch",
    externalId: "slack-msg-auth-blocker",
    dept: D.depts.engineering,
    visibility: "department",
    externalUrl: "https://meridian.slack.com/archives/C_ENG/p1716890100",
    createdAt: "2026-05-28T10:15:00Z",
    preview: "Auth v2 upgrade P1 blocker: frontend (SmartSync UI) and data platform (OAuth) cannot merge. PR #1901 needs 3 reviewers. ETA June 3. Directly blocks SmartSync June 15 launch.",
    fullText: "Auth service v2 upgrade is now a P1 blocker for two teams. Frontend team cannot merge SmartSync UI components until auth-v2 JWT claims are available. Data platform team OAuth integration also blocked on MER-878. PR #1901 open since May 23, needs 3 senior code reviewers. Estimated completion June 3 if reviewers assigned by tomorrow. This is on the critical path — if auth-v2 does not merge by June 3, SmartSync June 15 launch is at risk. Alex Kumar escalated to engineering all-hands. Need volunteers to review PR #1901 today.",
    metadata: { channel: "#engineering", author: "priya-nair", jira_ref: "MER-901", pr: "#1901" },
  },
  {
    id: D.docs.slack_smartsync,
    connId: D.conns.slack,
    sourceType: "slack",
    title: "#product — SmartSync Launch Status May 28",
    externalId: "slack-msg-smartsync-update",
    dept: D.depts.product,
    visibility: "org_wide",
    externalUrl: "https://meridian.slack.com/archives/C_PROD/p1716890400",
    createdAt: "2026-05-28T11:00:00Z",
    preview: "SmartSync launch update: core engine merged, UI 80% done, QA starts June 1. Critical risk: auth-v2 dependency must ship by June 3 or June 15 launch is at risk. 12 design partners waiting.",
    fullText: "SmartSync launch status update May 28 — Core sync engine merged (PR #1876, all tests passing, p99 340ms under target 500ms). UI components 80% complete, expected done May 31. QA environment setup starts Monday June 1. Documentation not yet started. Billing integration blocked on MER-901. Critical path risk: auth-v2 dependency must ship by June 3 or SmartSync June 15 launch is at risk. 12 enterprise design partners have been promised June 15. Priya Nair reviewing v1 spec with 3 design partners this week for final feedback.",
    metadata: { channel: "#product", author: "priya-nair", epic: "MER-800" },
  },
  {
    id: D.docs.slack_emea,
    connId: D.conns.slack,
    sourceType: "slack",
    title: "#sales — EMEA Q2 Pipeline Alert",
    externalId: "slack-msg-emea-pipeline",
    dept: D.depts.sales,
    visibility: "department",
    externalUrl: "https://meridian.slack.com/archives/C_SALES/p1716630000",
    createdAt: "2026-05-25T09:00:00Z",
    preview: "EMEA pipeline down 23% — $1.84M (was $2.39M April). At-risk: TechCorp UK $280K (SOC2 blocker), Infratek DE $145K (procurement freeze), Nordex FI $95K (champion left). Total $520K at risk.",
    fullText: "EMEA Q2 pipeline status — three enterprise deals stalled totaling $520K at risk. Pipeline now $1.84M down from $2.39M in April, a 23% drop in 5 weeks. TechCorp UK $280K: procurement blocked, waiting on SOC 2 Type II certification, estimated 3 month delay without acceleration. Infratek DE $145K: company-wide procurement freeze until Q3, champion still engaged. Nordex FI $95K: champion Sara Mäkinen left the company last week, need to identify new internal stakeholder. Marcus Reid scheduling rescue calls this week. EMEA win rate down to 22% versus global average 31%. Pipeline coverage ratio 2.8x against Q2 EMEA target of 3.5x.",
    metadata: { channel: "#sales", author: "marcus-reid", at_risk_total: 520000 },
  },
  {
    id: D.docs.slack_pricing,
    connId: D.conns.slack,
    sourceType: "slack",
    title: "#general — Usage-Based Pricing Announcement",
    externalId: "slack-msg-pricing-announce",
    dept: null,
    visibility: "org_wide",
    externalUrl: "https://meridian.slack.com/archives/C_GENERAL/p1746086400",
    createdAt: "2026-05-01T08:00:00Z",
    preview: "CEO announcement: Meridian moving to usage-based pricing May 1. $0.15/API call, $299/seat/month minimum. 73% of customers preferred usage-based in interviews. 30% lower CAC in pilot cohort.",
    fullText: "From Sarah Chen CEO — Company announcement effective May 1 2026: Meridian Labs is transitioning to usage-based pricing. New model: $0.15 per API call, $299 per seat per month minimum. This decision followed 6 months of customer discovery — 73% of enterprise customers preferred usage-based over flat seats in 1-on-1 interviews. Pilot cohort of 18 customers showed 30% lower CAC and 25% faster time-to-close. Projected revenue impact: short-term minus 8% expected in Q2, plus 35% projected by end of Q3 as customers expand usage. Full FAQ available in Notion. 90-day grace period for existing customers.",
    metadata: { channel: "#general", author: "sarah-chen", decision_id: "pricing-2026-05-01" },
  },
  {
    id: D.docs.slack_snowflake,
    connId: D.conns.slack,
    sourceType: "slack",
    title: "#engineering — Snowflake Migration Complete",
    externalId: "slack-msg-snowflake-done",
    dept: D.depts.engineering,
    visibility: "org_wide",
    externalUrl: "https://meridian.slack.com/archives/C_ENG/p1710252000",
    createdAt: "2026-03-12T12:00:00Z",
    preview: "Snowflake migration complete March 12. All analytics migrated from PostgreSQL OLAP. Query time: 45s→2.7s (94% improvement). dbt pipelines running on 2hr schedule. Legacy tables deprecated June 1.",
    fullText: "Snowflake migration completed March 12 2026. All analytics workloads migrated from legacy PostgreSQL OLAP queries to Snowflake warehouse. Results: average query time reduced from 45.2 seconds to 2.7 seconds — a 94% improvement across all dashboard queries. dbt pipeline models deployed and running on 2-hour refresh schedule via QStash. Query result cache with 5-minute TTL deployed in Redis. Legacy PostgreSQL analytics tables deprecated and scheduled for deletion June 1 to reduce database load. Big thanks to data-platform team: Ravi Shankar, Shreya Patel, and Omar Hassan for executing this flawlessly in 8 weeks.",
    metadata: { channel: "#engineering", author: "ravi-shankar", pr: "#1721" },
  },
  {
    id: D.docs.slack_feedback,
    connId: D.conns.slack,
    sourceType: "slack",
    title: "#product — Customer Feedback Summary May 2026",
    externalId: "slack-msg-nps-may",
    dept: D.depts.product,
    visibility: "org_wide",
    externalUrl: "https://meridian.slack.com/archives/C_PROD/p1716800000",
    createdAt: "2026-05-27T14:00:00Z",
    preview: "NPS 47 (up from 38 Q1, all-time high). Top driver: saves 3+ hrs/week. Top complaint: onboarding 2.1hrs. 3 enterprise customers requesting SSO/SAML. SmartSync beta NPS: 71.",
    fullText: "Monthly customer feedback summary May 2026 — NPS score 47, up from 38 in Q1, all-time company high. Response rate 41% across 420 active accounts. Promoters 61%, Passives 25%, Detractors 14%. Top promoter verbatim themes: saves 3 or more hours per week finding information, replaced 5 separate status meetings, best enterprise tool onboarding experience. Top detractor themes: onboarding still too complex averaging 2.1 hours time-to-value, missing SSO and SAML integration (mentioned in 11 separate responses), mobile experience lacking. Three separate enterprise customers requested SSO/SAML in May: TechCorp UK, Infratek DE, Nexus Financial. SmartSync beta users NPS: 71. Enterprise segment NPS: 58.",
    metadata: { channel: "#product", author: "priya-nair", nps_score: 47 },
  },
  {
    id: D.docs.slack_board,
    connId: D.conns.slack,
    sourceType: "slack",
    title: "#exec — Board Deck Prep June 3",
    externalId: "slack-msg-board-prep",
    dept: D.depts.executive,
    visibility: "department",
    externalUrl: "https://meridian.slack.com/archives/C_EXEC/p1716976800",
    createdAt: "2026-05-29T08:00:00Z",
    preview: "Board deck June 3: ARR $4.2M +18% YoY, runway 14 months, burn $380K/mo. Key asks: Series A approval Q4, EMEA $520K recovery plan. SmartSync is the growth story. EMEA plan due May 30.",
    fullText: "Board deck status for June 3 meeting. Key metrics: ARR $4.2M up 18% year-over-year, MRR $350K, month-over-month growth 6.2%, burn rate $380K per month, runway 14 months. Two board asks being prepared: approval to begin Series A process Q4 2026, and strategic review of EMEA investment given $520K at-risk pipeline. SmartSync is the primary growth narrative — projecting $45K MRR new revenue stream by end of Q3. Sarah wants EMEA recovery plan finalized by May 30 before board deck submission. Jordan Lee preparing SOC 2 timeline acceleration slide to address TechCorp UK blocker.",
    metadata: { channel: "#exec", author: "sarah-chen", board_meeting: "2026-06-03" },
  },

  // ── JIRA (7) ────────────────────────────────────────────────────────────────
  {
    id: D.docs.jira_p0,
    connId: D.conns.jira,
    sourceType: "jira",
    title: "MER-847: P0 Payment Service Latency Spike [RESOLVED]",
    externalId: "jira-MER-847",
    dept: D.depts.engineering,
    visibility: "department",
    externalUrl: "https://meridian.atlassian.net/browse/MER-847",
    createdAt: "2026-05-20T14:25:00Z",
    preview: "P0 RESOLVED — Payment service p99 exceeded 8s. Root cause: PostgreSQL connection pool max=20 exhausted post-deploy v2.4.1. Fix: pool 20→50. Resolved 14:58 UTC. 847 failures. Post-mortem May 24.",
    fullText: "MER-847 P0 RESOLVED — Payment service latency spike, p99 exceeded 8 seconds affecting all customer checkout flows. Root cause: PostgreSQL connection pool max setting of 20 caused exhaustion under normal load after deploy v2.4.1 introduced 3 new database queries per request, increasing per-request DB load by 40%. Fix applied: pool.max increased from 20 to 50, connectionTimeoutMillis reduced from 10s to 3s, idleTimeoutMillis from 30s to 10s. Resolved 14:58 UTC May 20 2026. Total impact: 35 minutes downtime, 847 checkout transaction failures. Post-mortem report due May 24, owned by Alex Kumar. Action items: add connection pool monitoring alerts, load test in staging before all future deploys.",
    metadata: { jira_key: "MER-847", priority: "P0", status: "RESOLVED", owner: "alex-kumar" },
  },
  {
    id: D.docs.jira_auth,
    connId: D.conns.jira,
    sourceType: "jira",
    title: "MER-901: Auth Service v2 — JWT + OAuth2 PKCE [IN PROGRESS]",
    externalId: "jira-MER-901",
    dept: D.depts.engineering,
    visibility: "department",
    externalUrl: "https://meridian.atlassian.net/browse/MER-901",
    createdAt: "2026-05-23T09:00:00Z",
    preview: "P1 IN PROGRESS — Auth v2 upgrade: JWT claims refresh + OAuth2 PKCE. Blocking SmartSync (MER-800), data platform OAuth (MER-878), billing integration (MER-912). PR #1901 open. ETA June 3.",
    fullText: "MER-901 P1 IN PROGRESS — Auth service v2 upgrade implementing JWT token claims refresh and OAuth2 PKCE flow. This ticket is blocking three downstream items: SmartSync launch (MER-800), data platform OAuth integration (MER-878), and SmartSync billing counters (MER-912). PR #1901 open since May 23, 847 lines changed across 23 files. Key changes: new JWT claim schema with department_id and feature_flags fields, PKCE challenge-response for mobile clients, token refresh endpoint with 7-day sliding window. CI status: 2 of 4 checks failing — integration-tests suite needs Vault dev token not available in GitHub Actions environment. 3 senior reviewers requested: alex-kumar, praveenk, eleanor-chan. If not merged by June 3, SmartSync June 15 launch is at risk.",
    metadata: { jira_key: "MER-901", priority: "P1", status: "IN_PROGRESS", owner: "dmitri-volkov", pr: "#1901" },
  },
  {
    id: D.docs.jira_smartsync,
    connId: D.conns.jira,
    sourceType: "jira",
    title: "MER-800: SmartSync Real-Time Sync Engine [EPIC]",
    externalId: "jira-MER-800",
    dept: D.depts.product,
    visibility: "org_wide",
    externalUrl: "https://meridian.atlassian.net/browse/MER-800",
    createdAt: "2026-04-01T09:00:00Z",
    preview: "EPIC IN PROGRESS — SmartSync real-time bidirectional sync. Launch June 15 2026. Core engine done, UI 80%, QA not started, billing blocked on MER-901. 12 design partners promised June 15. Owner: Priya Nair.",
    fullText: "MER-800 EPIC IN PROGRESS — SmartSync real-time bidirectional data synchronization for enterprise customers. Target launch June 15 2026. Sub-task completion: core sync engine 100% merged (PR #1876), UI components 80% done ETA May 31, QA not yet started (starts June 1), documentation 0%, billing integration blocked on MER-901. SLO commitments: 99.9% uptime, p99 sync latency under 500ms, zero data loss guarantee. Staging performance: p99 340ms under target. 12 enterprise design partners have been promised June 15 availability. Pricing: $0.02 per sync event, minimum $99/month, usage-based billing starting July 1. Risk: MER-901 on critical path, must complete June 3. Owner: Priya Nair.",
    metadata: { jira_key: "MER-800", priority: "EPIC", status: "IN_PROGRESS", owner: "priya-nair" },
  },
  {
    id: D.docs.jira_billing,
    connId: D.conns.jira,
    sourceType: "jira",
    title: "MER-912: SmartSync Billing Integration [BLOCKED]",
    externalId: "jira-MER-912",
    dept: D.depts.engineering,
    visibility: "department",
    externalUrl: "https://meridian.atlassian.net/browse/MER-912",
    createdAt: "2026-05-15T11:00:00Z",
    preview: "BLOCKED on MER-901 — SmartSync usage metering for sync events. Cannot implement billing counters without new auth-v2 JWT claims. ETA June 8 if auth-v2 ships June 3. Revenue impact: $45K MRR by Q3.",
    fullText: "MER-912 BLOCKED — SmartSync billing integration, usage-based metering for sync events. Blocked on auth-v2 MER-901. Cannot implement per-sync-event billing counters without new JWT token claims available from auth-v2. Design: each sync event writes atomically to usage_events table, aggregated hourly via Snowflake pipeline, invoiced monthly via Stripe. Revenue model: $0.02 per sync event at launch. Projected revenue: $45K MRR by end of Q3 2026 based on design partner usage estimates. ETA June 8 if auth-v2 ships June 3. Owner: platform-billing team. Dependency chain: MER-901 → MER-912 → SmartSync billing live.",
    metadata: { jira_key: "MER-912", priority: "P1", status: "BLOCKED", blocked_by: "MER-901" },
  },
  {
    id: D.docs.jira_soc2,
    connId: D.conns.jira,
    sourceType: "jira",
    title: "MER-750: SOC 2 Type II Audit Preparation [IN PROGRESS]",
    externalId: "jira-MER-750",
    dept: D.depts.operations,
    visibility: "department",
    externalUrl: "https://meridian.atlassian.net/browse/MER-750",
    createdAt: "2026-04-15T09:00:00Z",
    preview: "IN PROGRESS — SOC 2 Type II target Q3 2026. Auditor: Schellman. Audit window July 1–Aug 31. Gaps: access review policy, vendor risk (23 vendors), incident response plan. Vanta 67% green. Blocks TechCorp UK $280K.",
    fullText: "MER-750 IN PROGRESS — SOC 2 Type II audit preparation, target certification Q3 2026. Auditor: Schellman and Company, engagement letter signed April 15. Audit window: July 1 through August 31 2026. Vanta compliance platform deployed, 67% of controls green, 33% in remediation. Current gaps requiring remediation: access review policy needs formalization (owner: Jordan Lee), vendor risk assessment for 23 critical vendors not yet completed (owner: Jordan Lee), incident response plan in draft (owner: Alex Kumar). Completion of SOC 2 directly unblocks TechCorp UK deal close worth $280K. Also required by Infratek DE and Nexus Financial. Estimated 8 weeks to completion. Owner: Jordan Lee, Head of Operations.",
    metadata: { jira_key: "MER-750", priority: "P1", status: "IN_PROGRESS", owner: "jordan-lee" },
  },
  {
    id: D.docs.jira_emea_bug,
    connId: D.conns.jira,
    sourceType: "jira",
    title: "MER-889: EMEA Invoice Currency Formatting Bug [IN PROGRESS]",
    externalId: "jira-MER-889",
    dept: D.depts.engineering,
    visibility: "department",
    externalUrl: "https://meridian.atlassian.net/browse/MER-889",
    createdAt: "2026-05-15T14:00:00Z",
    preview: "IN PROGRESS — EUR decimal formatting shows period instead of comma in invoice PDFs for DE, FI, SE customers. Affects 34 EMEA customers. TechCorp UK raised billing dispute May 18. Fix ETA June 2.",
    fullText: "MER-889 IN PROGRESS — EMEA currency formatting bug in invoice PDFs. EUR decimal separator displaying as period instead of comma for German, Finnish, and Swedish customers. Root cause: PDF renderer using hard-coded en-US locale override, not respecting per-customer locale settings. Affects 34 active EMEA customers across Germany, Finland, and Sweden. TechCorp UK raised formal billing dispute on May 18 citing invoice formatting errors on 3 months of invoices. Fix in code review: locale-aware number formatter in invoice-service/src/pdf.ts, adding locale lookup from customer profile. Owner: Kai Mueller, frontend team. ETA: June 2. This may be contributing to friction in TechCorp UK renewal negotiations.",
    metadata: { jira_key: "MER-889", priority: "P2", status: "IN_PROGRESS", owner: "kai-mueller" },
  },
  {
    id: D.docs.jira_sso,
    connId: D.conns.jira,
    sourceType: "jira",
    title: "MER-920: Enterprise SSO/SAML Integration [BACKLOG]",
    externalId: "jira-MER-920",
    dept: D.depts.engineering,
    visibility: "org_wide",
    externalUrl: "https://meridian.atlassian.net/browse/MER-920",
    createdAt: "2026-05-20T10:00:00Z",
    preview: "BACKLOG — SSO/SAML requested by 3 enterprise customers in May: TechCorp UK, Infratek DE, Nexus Financial. TechCorp says it's a procurement requirement. Estimate: 3-4 weeks. Not on Q2 roadmap. Flagged for Q3.",
    fullText: "MER-920 BACKLOG — Enterprise SSO/SAML integration requested by three enterprise customers in May 2026. Requestors: TechCorp UK (explicitly stated as procurement requirement, deal $280K blocked), Infratek DE (required for IT approval), Nexus Financial (new $190K prospect, SSO is deal-breaker). Current state: no SSO implementation exists. Estimate: 3 to 4 weeks of backend work for SAML 2.0 integration via standard library. Not currently on Q2 engineering roadmap — full roadmap is SmartSync, auth-v2, SOC2, performance work. Priya Nair flagging for Q3 planning. If TechCorp UK and Infratek DE close, SSO gets fast-tracked. Owner: unassigned. Decision needed by June 10 for Q3 roadmap planning.",
    metadata: { jira_key: "MER-920", priority: "P2", status: "BACKLOG", customers: ["TechCorp UK", "Infratek DE", "Nexus Financial"] },
  },

  // ── GITHUB (4) ──────────────────────────────────────────────────────────────
  {
    id: D.docs.github_hotfix,
    connId: D.conns.github,
    sourceType: "github",
    title: "PR #1847: hotfix — PostgreSQL connection pool max 20→50 [MERGED]",
    externalId: "github-pr-1847",
    dept: D.depts.engineering,
    visibility: "department",
    externalUrl: "https://github.com/meridian-labs/backend/pull/1847",
    createdAt: "2026-05-20T15:55:00Z",
    preview: "MERGED — Emergency hotfix for P0 MER-847. pool.max 20→50, connectionTimeoutMillis 10s→3s, idleTimeoutMillis 30s→10s. Reviewed by praveenk, sriram in 20min. Deployed via hotfix pipeline.",
    fullText: "PR #1847 MERGED — hotfix: increase PostgreSQL connection pool max from 20 to 50 for payment-service. Emergency fix for P0 incident MER-847. Merged May 20 2026 16:02 UTC by alex-kumar. Changes in config/database.ts: pool.max 20→50, connectionTimeoutMillis 10000→3000, idleTimeoutMillis 30000→10000. Reviewed and approved by praveenk and sriram in under 20 minutes via direct Slack request. All existing tests passing. Deployed to production via hotfix pipeline bypassing full CI suite to minimize recovery time. Full CI run completed post-deploy, all green. Load test with pool=50 shows zero connection failures at 5x normal concurrent load.",
    metadata: { pr_number: 1847, merged_by: "alex-kumar", resolves: "MER-847", lines_changed: 8 },
  },
  {
    id: D.docs.github_auth_v2,
    connId: D.conns.github,
    sourceType: "github",
    title: "PR #1901: feat — Auth Service v2 JWT + PKCE [OPEN]",
    externalId: "github-pr-1901",
    dept: D.depts.engineering,
    visibility: "department",
    externalUrl: "https://github.com/meridian-labs/auth-service/pull/1901",
    createdAt: "2026-05-23T16:00:00Z",
    preview: "OPEN — Auth v2: JWT claims refresh + OAuth2 PKCE. 847 lines, 23 files. CI failing (Vault token missing in GHA). 3 reviewers requested. Linked: MER-901, MER-856, MER-912. Blocking SmartSync launch.",
    fullText: "PR #1901 OPEN — feat: auth-service-v2 JWT token claims refresh and OAuth2 PKCE flow. Branch feature/auth-v2, 847 lines changed across 23 files. Key changes: new JWT claim schema adding department_id, feature_flags, and org_tier fields; PKCE challenge-response flow for mobile and SPA clients; token refresh endpoint with 7-day sliding window; backward-compatible migration path for existing tokens. CI status: 2 of 4 checks failing — integration-tests suite requires Vault dev token which is not available in GitHub Actions environment; workaround documented in PR description. Reviewers requested: alex-kumar, praveenk, eleanor-chan. Linked issues: MER-901 (P1 blocker), MER-856 (SmartSync UI dep), MER-912 (billing dep). This PR is on the SmartSync June 15 critical path.",
    metadata: { pr_number: 1901, status: "open", author: "dmitri-volkov", lines_changed: 847 },
  },
  {
    id: D.docs.github_smartsync,
    connId: D.conns.github,
    sourceType: "github",
    title: "PR #1876: feat — SmartSync Core Sync Engine [MERGED]",
    externalId: "github-pr-1876",
    dept: D.depts.engineering,
    visibility: "org_wide",
    externalUrl: "https://github.com/meridian-labs/smartsync/pull/1876",
    createdAt: "2026-05-26T17:30:00Z",
    preview: "MERGED — SmartSync core engine: event sourcing, vector clock conflict resolution, exponential backoff retry. 2341 lines. Staging p99 340ms (target <500ms). Test coverage 94%. Load test: 10K concurrent events, zero loss.",
    fullText: "PR #1876 MERGED — feat: SmartSync core sync engine using event sourcing architecture with conflict resolution. Merged May 26 2026 by priya-nair. 2341 lines across 47 files. Architecture: WebSocket event bus per customer workspace, vector clock conflict resolution for concurrent edits, exponential backoff retry with dead letter queue for failed syncs, ordered event log per entity. Performance in staging environment: p50 120ms, p95 280ms, p99 340ms — all within 500ms SLO target. Test coverage 94%. Load test results: 10 thousand concurrent sync events, zero message loss, zero ordering violations. SmartSync billing counters blocked on auth-v2 PR #1901. UI integration blocked on same. Full launch requires MER-901 merge first.",
    metadata: { pr_number: 1876, merged_by: "priya-nair", lines_changed: 2341, test_coverage: "94%" },
  },
  {
    id: D.docs.github_snowflake,
    connId: D.conns.github,
    sourceType: "github",
    title: "PR #1721: feat — Snowflake Analytics Connector [MERGED]",
    externalId: "github-pr-1721",
    dept: D.depts.engineering,
    visibility: "org_wide",
    externalUrl: "https://github.com/meridian-labs/analytics/pull/1721",
    createdAt: "2026-03-12T10:00:00Z",
    preview: "MERGED March 12 — Snowflake connector replacing PostgreSQL OLAP. 1180 lines. Query time: 45s→2.7s avg. dbt model sync on QStash schedule. Redis query cache 5min TTL. Closes MER-612.",
    fullText: "PR #1721 MERGED — feat: Snowflake analytics connector replacing legacy PostgreSQL OLAP queries. Merged March 12 2026. 1180 lines across 28 files. Adds: SnowflakeQueryBuilder class with parameterized queries preventing injection, dbt model sync script running on QStash cron every 2 hours, Redis query result cache with 5-minute TTL reducing Snowflake compute costs. Performance improvement measured across all dashboard queries: average query time reduced from 45.2 seconds to 2.7 seconds, a 94% improvement. P95 query time: 8.3 seconds. Breaking change: analytics-service now requires SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD, SNOWFLAKE_DATABASE, SNOWFLAKE_WAREHOUSE environment variables. Closes MER-612.",
    metadata: { pr_number: 1721, merged_by: "ravi-shankar", lines_changed: 1180, perf_improvement: "94%" },
  },

  // ── SNOWFLAKE (4) ───────────────────────────────────────────────────────────
  {
    id: D.docs.snow_revenue,
    connId: D.conns.snowflake,
    sourceType: "snowflake",
    title: "revenue_metrics_q2_2026 — Q2 Revenue Dashboard",
    externalId: "snowflake-table-revenue-q2",
    dept: D.depts.executive,
    visibility: "bi_accessible",
    externalUrl: "https://app.snowflake.com/meridian/revenue_metrics_q2_2026",
    createdAt: "2026-05-29T06:00:00Z",
    preview: "ARR $4.2M +18.3% YoY. MRR $350K. Net new ARR May: $47K (new $31K, expansion $28K, churn -$12K). NRR 108.3%. Burn multiple 2.1x. CAC payback 11mo (was 14mo). Runway 14 months at $380K/mo burn.",
    fullText: "Snowflake table revenue_metrics_q2_2026 as of May 29 2026. ARR $4.2M up 18.3% year-over-year. MRR $350K. Net new ARR in May: $47K (new logos $31K, expansion revenue $28K, churn negative $12K from 2 SMB customers citing pricing change). SmartSync early access upsells: 8 customers contributing $28K expansion. Gross revenue retention 97.1%. Net revenue retention 108.3%. Top customer cohort: Series B companies 25 to 100 employees representing 41% of ARR. Burn rate $380K per month. Runway 14 months at current burn. Burn multiple 2.1x. CAC payback period 11 months, improved from 14 months following usage-based pricing transition. Monthly growth rate 6.2%.",
    metadata: { table: "revenue_metrics_q2_2026", refreshed_at: "2026-05-29T06:00:00Z" },
  },
  {
    id: D.docs.snow_emea,
    connId: D.conns.snowflake,
    sourceType: "snowflake",
    title: "pipeline_regional_q2_2026 — EMEA Pipeline Report",
    externalId: "snowflake-table-emea-pipeline",
    dept: D.depts.sales,
    visibility: "bi_accessible",
    externalUrl: "https://app.snowflake.com/meridian/pipeline_regional_q2_2026",
    createdAt: "2026-05-29T06:00:00Z",
    preview: "EMEA pipeline $1.84M (was $2.39M April, -23%). 3 deals >$100K stalled: TechCorp UK $280K, Infratek DE $145K, Nordex FI $95K. Avg days-in-stage 67 (benchmark 45). Win rate 22% vs global 31%.",
    fullText: "Snowflake table pipeline_regional_q2_2026 EMEA segment as of May 27 2026. Total EMEA pipeline $1.84M, down from $2.39M in April, a 23% decrease in 5 weeks. At-risk deals over $100K: TechCorp UK $280K in negotiation stage stuck 47 days waiting SOC2, Infratek DE $145K in evaluation stage under procurement freeze, Nordex FI $95K in discovery stage after champion departure. Total at-risk $520K. Average days-in-stage for EMEA: 67 days versus global benchmark of 45 days. EMEA win rate 22% versus global average 31%. EMEA pipeline coverage ratio 2.8x against Q2 EMEA revenue target requiring 3.5x coverage. EMEA contributes 31% of global pipeline but only 18% of closed deals this quarter.",
    metadata: { table: "pipeline_regional_q2_2026", region: "EMEA", refreshed_at: "2026-05-29T06:00:00Z" },
  },
  {
    id: D.docs.snow_usage,
    connId: D.conns.snowflake,
    sourceType: "snowflake",
    title: "product_usage_may_2026 — Product Engagement Metrics",
    externalId: "snowflake-table-usage-may",
    dept: D.depts.product,
    visibility: "bi_accessible",
    externalUrl: "https://app.snowflake.com/meridian/product_usage_may_2026",
    createdAt: "2026-05-29T06:00:00Z",
    preview: "DAU 847 (+12% MoM). API calls/day 2.3M. SmartSync beta users 124 (target 200). Feature adoption: chat 84%, briefings 68%, graph 41%. Top queries: engineering status 32%, pipeline 28%, decisions 18%.",
    fullText: "Snowflake table product_usage_may_2026 as of May 28 2026. Daily active users 847, up 12% month-over-month. Monthly active users 2840. API calls per day 2.3 million. SmartSync beta program: 124 active users out of 200 target needed for launch readiness signal. Average session duration 18 minutes. Feature adoption rates: chat interface 84%, morning briefing 68%, knowledge graph 41%, builder automations 19%, reports 12%. Top query intent categories in chat: engineering status and blockers 32%, pipeline and sales updates 28%, decisions and company history 18%, people and teams 12%, other 10%. Top 3 power users by session frequency: CEO, CTO, VP Sales — confirming executive use case hypothesis.",
    metadata: { table: "product_usage_may_2026", refreshed_at: "2026-05-29T06:00:00Z" },
  },
  {
    id: D.docs.snow_nps,
    connId: D.conns.snowflake,
    sourceType: "snowflake",
    title: "nps_survey_q2_may_2026 — NPS & Customer Satisfaction",
    externalId: "snowflake-table-nps-q2",
    dept: D.depts.product,
    visibility: "bi_accessible",
    externalUrl: "https://app.snowflake.com/meridian/nps_survey_q2_may_2026",
    createdAt: "2026-05-29T06:00:00Z",
    preview: "NPS 47 (Q1: 38, all-time high). Promoters 61%, Detractors 14%. Top promoter: saves 3+ hrs/week. Top detractor: onboarding 2.1hrs, missing SSO (11 mentions). Enterprise NPS 58. SmartSync beta NPS 71.",
    fullText: "Snowflake table nps_survey_q2_may_2026 as of May 28 2026. Overall NPS score 47, up from 38 in Q1, up from 31 in Q4 2025 — all-time company high. Response rate 41% across 420 active accounts, 172 responses. Promoters 61%, Passives 25%, Detractors 14%. Top promoter verbatim themes: saves 3 or more hours per week finding information (38 mentions), replaced 5 or more status meetings per week (22 mentions), best enterprise software onboarding experience (18 mentions). Top detractor verbatim themes: onboarding process too complex averaging 2.1 hours to first value (29 mentions), missing SSO and SAML support (11 mentions), mobile experience lacks key features (8 mentions). Segment NPS: enterprise 58, growth 44, SMB 29. SmartSync beta NPS: 71.",
    metadata: { table: "nps_survey_q2_may_2026", refreshed_at: "2026-05-29T06:00:00Z" },
  },

  // ── GOOGLE DRIVE (5) ────────────────────────────────────────────────────────
  {
    id: D.docs.gdrive_roadmap,
    connId: D.conns.gdrive,
    sourceType: "gdrive",
    title: "Q2 2026 Engineering Roadmap",
    externalId: "gdrive-doc-q2-roadmap",
    dept: D.depts.engineering,
    visibility: "org_wide",
    externalUrl: "https://drive.google.com/file/d/meridian-q2-roadmap",
    createdAt: "2026-04-01T09:00:00Z",
    preview: "Q2 priorities: 1) SmartSync June 15, 2) Auth v2 by June 3 (blocks SmartSync + 2 teams), 3) SOC2 evidence tooling June 30, 4) API p99 <200ms (now 320ms), 5) post-MER-847 monitoring. 2 backend hires approved.",
    fullText: "Q2 2026 Engineering Roadmap. Priority 1: SmartSync launch June 15 — requires auth-v2 merged by June 3, QA pass by June 10, documentation complete by June 12. Priority 2: Auth service v2 upgrade by June 3 — currently P1 blocker for frontend and data platform teams. Priority 3: SOC 2 evidence tooling automation by June 30 — Vanta integration complete, automated access review workflow. Priority 4: API performance — reduce p99 latency from current 320ms to under 200ms target. Priority 5: Post-mortem action items from MER-847 payment incident — connection pool monitoring alerts in Datadog, mandatory load testing in staging before all production deploys. Headcount: 2 senior backend engineers approved for Q2 hiring, JDs posted.",
    metadata: { doc_type: "roadmap", author: "alex-kumar", quarter: "Q2-2026" },
  },
  {
    id: D.docs.gdrive_pricing,
    connId: D.conns.gdrive,
    sourceType: "gdrive",
    title: "Decision: Usage-Based Pricing Transition — April 28 2026",
    externalId: "gdrive-doc-pricing-decision",
    dept: D.depts.executive,
    visibility: "org_wide",
    externalUrl: "https://drive.google.com/file/d/meridian-pricing-decision",
    createdAt: "2026-04-28T16:00:00Z",
    preview: "Decision April 28 2026: move to usage-based pricing May 1. $0.15/API call, $299/seat minimum. Unanimous: Sarah Chen, Marcus Reid, Priya Nair. Rationale: 73% customer preference, 30% lower CAC in pilot. Reversible within 60 days.",
    fullText: "Decision Document — Usage-Based Pricing Transition, April 28 2026. Decision: move to usage-based pricing model effective May 1 2026. Decision makers: Sarah Chen CEO, Marcus Reid VP Sales, Priya Nair VP Product — unanimous approval. Rationale: 6 months of customer discovery showed 73% of enterprise customers preferred usage-based over flat seats in direct interviews. Pilot cohort of 18 customers on usage-based pricing saw 30% lower CAC and 25% faster sales cycle closure. New pricing: $0.15 per API call, $299 per seat per month minimum commitment. Revenue impact projection: minus 8% short-term in Q2 as customers adjust, plus 35% projected by end of Q3 2026 as high-usage customers expand. Risk mitigation: 90-day grace period for existing customers at no penalty. Reversibility clause: pricing change reversible within 60 days if monthly churn exceeds 5%.",
    metadata: { doc_type: "decision", decision_date: "2026-04-28", authors: ["sarah-chen", "marcus-reid", "priya-nair"] },
  },
  {
    id: D.docs.gdrive_smartsync,
    connId: D.conns.gdrive,
    sourceType: "gdrive",
    title: "SmartSync Product Specification v1.4",
    externalId: "gdrive-doc-smartsync-spec",
    dept: D.depts.product,
    visibility: "org_wide",
    externalUrl: "https://drive.google.com/file/d/meridian-smartsync-spec",
    createdAt: "2026-05-10T11:00:00Z",
    preview: "SmartSync spec v1.4: real-time bidirectional sync, <500ms p99, 99.9% uptime. Event sourcing + WebSocket + vector clock conflict resolution. $0.02/sync event, min $99/mo, billing July 1. 10 of 12 design partners: must-have.",
    fullText: "SmartSync Product Specification v1.4. Real-time bidirectional sync engine for Meridian enterprise customers. Core use case: field teams and distributed organizations need data changes reflected within 1 second. Architecture: event sourcing with WebSocket push per workspace, vector clock conflict resolution for concurrent edits, dead letter queue for failed syncs with automatic retry. SLO commitments: 99.9% uptime, p99 sync latency under 500ms, zero data loss guarantee backed by event log. Pricing: usage-based at $0.02 per sync event, minimum $99 per month commitment. Billing starts July 1 2026, 30-day free period for existing customers. Design partner feedback: 12 enterprise customers tested closed beta, 10 of 12 rated real-time sync as a must-have feature, 2 of 12 rated as nice-to-have. Go-to-market strategy: land-and-expand within existing accounts first, targeting customers with distributed teams.",
    metadata: { doc_type: "product_spec", version: "1.4", author: "priya-nair" },
  },
  {
    id: D.docs.gdrive_board,
    connId: D.conns.gdrive,
    sourceType: "gdrive",
    title: "Board Deck — May 2026 (June 3 Meeting)",
    externalId: "gdrive-doc-board-deck-may",
    dept: D.depts.executive,
    visibility: "department",
    externalUrl: "https://drive.google.com/file/d/meridian-board-deck-may26",
    createdAt: "2026-05-28T09:00:00Z",
    preview: "Board deck June 3: ARR $4.2M +18% YoY, runway 14mo, NPS 47 all-time high. Asks: Series A process approval Q4, EMEA $520K recovery plan. SmartSync $45K MRR growth story. SOC2 acceleration slide for TechCorp.",
    fullText: "Board Deck Meridian Labs May 2026 for June 3 board meeting. Executive summary: ARR $4.2M up 18% year-over-year, runway 14 months at $380K monthly burn, NPS 47 all-time high. Strategic priorities for board review: item 1 SmartSync launch June 15 as Q3 growth catalyst targeting $45K MRR new revenue stream from usage billing. Item 2 EMEA recovery plan — $520K pipeline at risk across 3 stalled enterprise deals, root causes SOC2 certification gap and procurement timing. Item 3 SOC 2 Type II certification by Q3 to unblock enterprise procurement requirements, directly enables TechCorp UK $280K close. Item 4 Series A readiness assessment for Q4 2026 fundraise. Board asks: approval to begin Series A process, authorization for VP Sales and engineering leadership hires. Key risk flagged: auth-v2 upgrade delay could push SmartSync launch past June 15.",
    metadata: { doc_type: "board_deck", meeting_date: "2026-06-03", author: "sarah-chen" },
  },
  {
    id: D.docs.gdrive_emea,
    connId: D.conns.gdrive,
    sourceType: "gdrive",
    title: "EMEA Q2 Recovery Plan — May 27 2026",
    externalId: "gdrive-doc-emea-recovery",
    dept: D.depts.sales,
    visibility: "department",
    externalUrl: "https://drive.google.com/file/d/meridian-emea-recovery",
    createdAt: "2026-05-27T16:00:00Z",
    preview: "EMEA recovery plan for 3 stalled deals ($520K total). TechCorp UK: accelerate SOC2, Sarah calls CTO. Infratek DE: exec-to-exec call June 2, custom contract terms. Nordex FI: find new champion via LinkedIn, SmartSync beta offer.",
    fullText: "EMEA Q2 Recovery Plan May 27 2026. Three at-risk deals requiring immediate executive action. TechCorp UK $280K: root cause — procurement blocked on SOC2 certification gap and invoice formatting dispute. Action plan: accelerate SOC2 timeline, deliver completed security questionnaire and interim pen test report by June 15, Sarah Chen to call TechCorp CTO directly this week, resolve MER-889 invoice bug by June 2 to clear billing dispute. Infratek DE $145K: root cause — company-wide procurement freeze until Q3. Action plan: schedule executive-to-executive call between Sarah Chen and Infratek CTO for week of June 2, offer custom enterprise contract with procurement-freeze protection clause and 60-day delayed billing start, keep champion warm with weekly product updates. Nordex FI $95K: root cause — champion Sara Mäkinen departed company. Action plan: identify new internal champion via LinkedIn Sales Navigator, re-engage with SmartSync closed beta access and custom ROI case study. Success target: at least 2 of 3 deals back in active negotiation by June 15.",
    metadata: { doc_type: "recovery_plan", author: "marcus-reid", total_at_risk: 520000 },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function embedWithJina(texts: string[]): Promise<number[][]> {
  if (!JINA_API_KEY) throw new Error("JINA_API_KEY not set in .env.local");
  const res = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${JINA_API_KEY}`,
    },
    body: JSON.stringify({ model: "jina-embeddings-v3", input: texts, dimensions: 768 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jina embed failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}

function log(msg: string) {
  console.log(`  ${msg}`);
}

// ─── Seed functions ───────────────────────────────────────────────────────────
async function seedDepartments(orgId: string) {
  const rows = [
    { id: D.depts.engineering, org_id: orgId, name: "Engineering",  slug: "engineering-demo" },
    { id: D.depts.product,     org_id: orgId, name: "Product",      slug: "product-demo" },
    { id: D.depts.sales,       org_id: orgId, name: "Sales",        slug: "sales-demo" },
    { id: D.depts.operations,  org_id: orgId, name: "Operations",   slug: "operations-demo" },
    { id: D.depts.executive,   org_id: orgId, name: "Executive",    slug: "executive-demo" },
  ];
  await db.from("departments").upsert(rows, { onConflict: "id" }).throwOnError();
  log(`✓ 5 departments`);
}

async function seedConnections(orgId: string, memberId: string) {
  const now = new Date().toISOString();
  const conns = [
    { id: D.conns.slack,     provider: "slack",     source_type: "slack",     nango_connection_id: "demo-slack-conn",     metadata: { team_name: "Meridian Labs", workspace_name: "meridian-labs" } },
    { id: D.conns.jira,      provider: "atlassian", source_type: "jira",      nango_connection_id: "demo-jira-conn",      metadata: { site_name: "meridian.atlassian.net", project: "MER" } },
    { id: D.conns.github,    provider: "github",    source_type: "github",    nango_connection_id: "demo-github-conn",    metadata: { org_name: "meridian-labs", repos: ["backend", "frontend", "auth-service", "smartsync", "analytics"] } },
    { id: D.conns.snowflake, provider: "snowflake", source_type: "snowflake", nango_connection_id: "demo-snowflake-conn", metadata: { account: "meridian.snowflakecomputing.com", warehouse: "ANALYTICS_WH" } },
    { id: D.conns.gdrive,    provider: "google",    source_type: "gdrive",    nango_connection_id: "demo-gdrive-conn",    metadata: { team_drive: "Meridian Shared Drive" } },
  ];

  for (const c of conns) {
    await db.from("connections").upsert({
      id: c.id,
      org_id: orgId,
      user_id: memberId,
      nango_connection_id: c.nango_connection_id,
      provider: c.provider,
      source_type: c.source_type,
      scope: "org",
      status: "active",
      last_synced_at: now,
      metadata: c.metadata,
    }, { onConflict: "id" }).throwOnError();

    await db.from("nango_connections").upsert({
      org_id: orgId,
      connection_id: c.nango_connection_id,
      provider_config_key: c.provider,
    }, { onConflict: "org_id,connection_id,provider_config_key" }).throwOnError();
  }

  for (const c of conns) {
    await db.from("sync_jobs").upsert({
      org_id: orgId,
      connection_id: c.id,
      status: "completed",
      job_type: "full",
      docs_processed: Math.floor(Math.random() * 200) + 50,
      docs_added:     Math.floor(Math.random() * 150) + 20,
      chunks_created: Math.floor(Math.random() * 800) + 200,
      idempotency_key: `demo-sync-${c.id}`,
      started_at: new Date(Date.now() - 3600000).toISOString(),
      completed_at: now,
    }, { onConflict: "idempotency_key" }).throwOnError();
  }

  log(`✓ 5 connections (Slack, Jira, GitHub, Snowflake, Google Drive)`);
}

async function seedDocuments(orgId: string, memberId: string) {
  log(`  Inserting ${DOCS.length} document metadata rows…`);
  for (const doc of DOCS) {
    await db.from("documents").upsert({
      id: doc.id,
      org_id: orgId,
      connection_id: doc.connId,
      external_id: doc.externalId,
      title: doc.title,
      source_type: doc.sourceType,
      department_id: doc.dept,
      owner_user_id: memberId,
      visibility: doc.visibility,
      external_url: doc.externalUrl,
      chunk_count: 1,
      last_indexed_at: doc.createdAt,
      metadata: doc.metadata,
    }, { onConflict: "id" }).throwOnError();
  }

  log(`  Generating ${DOCS.length} embeddings via Jina AI (one batch)…`);
  const texts = DOCS.map((d) => d.fullText);
  const embeddings = await embedWithJina(texts);

  log(`  Inserting ${DOCS.length} document_embeddings…`);
  const embRows = DOCS.map((doc, i) => ({
    org_id: orgId,
    document_id: doc.id,
    chunk_index: 0,
    content_preview: doc.preview.slice(0, 200),
    embedding: `[${embeddings[i].join(",")}]`,
    department_id: doc.dept,
    owner_user_id: memberId,
    visibility: doc.visibility,
    source_type: doc.sourceType,
    token_count: Math.ceil(doc.fullText.length / 4),
    metadata: { title: doc.title, external_url: doc.externalUrl, author: (doc.metadata as any).author ?? null },
  }));

  await db.from("document_embeddings")
    .upsert(embRows, { onConflict: "document_id,chunk_index" })
    .throwOnError();

  log(`✓ ${DOCS.length} documents + embeddings`);
}

async function seedKnowledgeGraph(orgId: string) {
  const n = D.kg;
  const nodes = [
    { id: n.n_smartsync,   org_id: orgId, label: "SmartSync",              entity_type: "project",    visibility: "org_wide",    description: "Real-time bidirectional sync engine. Target launch June 15 2026. Core engine merged, UI 80% complete." },
    { id: n.n_auth_v2,     org_id: orgId, label: "Auth Service v2",         entity_type: "service",    visibility: "org_wide",    description: "JWT claims refresh + OAuth2 PKCE upgrade. P1 blocker for SmartSync, data platform, and billing." },
    { id: n.n_payment_svc, org_id: orgId, label: "Payment Service",         entity_type: "service",    visibility: "org_wide",    description: "Checkout payment processing service. Had P0 incident May 20 (MER-847) — resolved. Connection pool max increased to 50." },
    { id: n.n_emea_pipe,   org_id: orgId, label: "EMEA Pipeline Q2",        entity_type: "concept",    visibility: "org_wide",    description: "EMEA sales pipeline $1.84M, down 23% from April. $520K at risk across 3 stalled deals." },
    { id: n.n_pricing,     org_id: orgId, label: "Usage-Based Pricing",     entity_type: "decision",   visibility: "org_wide",    description: "Decision April 28: move to $0.15/API call + $299/seat minimum. Effective May 1 2026.", temporal_metadata: { occurred_at: "2026-04-28T16:00:00Z", decision_makers: ["Sarah Chen", "Marcus Reid", "Priya Nair"] } },
    { id: n.n_snowflake,   org_id: orgId, label: "Snowflake",               entity_type: "technology", visibility: "org_wide",    description: "Analytics data warehouse. Migrated from PostgreSQL OLAP March 12. Query time 45s→2.7s (94% improvement)." },
    { id: n.n_soc2,        org_id: orgId, label: "SOC 2 Type II",           entity_type: "process",    visibility: "org_wide",    description: "Audit preparation in progress. Schellman auditor. Audit window July 1–Aug 31 2026. 67% controls green. Directly unblocks TechCorp UK $280K deal." },
    { id: n.n_launch,      org_id: orgId, label: "SmartSync Launch June 15", entity_type: "decision",  visibility: "org_wide",    description: "Launch date decision for SmartSync. 12 design partners committed. At risk if Auth v2 misses June 3.", temporal_metadata: { occurred_at: "2026-05-15T00:00:00Z" } },
    { id: n.n_techcorp,    org_id: orgId, label: "TechCorp UK",             entity_type: "concept",    visibility: "org_wide",    description: "Enterprise prospect. $280K deal stalled 47 days in negotiation. Blocked by SOC2 gap and invoice formatting bug." },
    { id: n.n_sarah,       org_id: orgId, label: "Sarah Chen",              entity_type: "person",     visibility: "org_wide",    description: "CEO of Meridian Labs. Decision maker on pricing, strategy, and Series A planning." },
    { id: n.n_alex,        org_id: orgId, label: "Alex Kumar",              entity_type: "person",     visibility: "org_wide",    description: "CTO. Owns engineering roadmap, auth-v2, post-mortem MER-847, and Series A technical due diligence prep." },
    { id: n.n_priya,       org_id: orgId, label: "Priya Nair",              entity_type: "person",     visibility: "org_wide",    description: "VP Product. SmartSync epic owner. Driving Q3 SSO/SAML roadmap decision. NPS program owner." },
    { id: n.n_marcus,      org_id: orgId, label: "Marcus Reid",             entity_type: "person",     visibility: "org_wide",    description: "VP Sales. EMEA pipeline owner. Executing EMEA recovery plan. Contributed to usage-based pricing decision." },
    { id: n.n_eng_team,    org_id: orgId, label: "Engineering Team",        entity_type: "team",       visibility: "org_wide",    description: "Backend and frontend engineers. Owns auth-v2, SmartSync engine, payment service, SOC2 tooling." },
    { id: n.n_sales_team,  org_id: orgId, label: "Sales Team",              entity_type: "team",       visibility: "org_wide",    description: "Owns EMEA and global pipeline. Executing Q2 recovery plan for 3 stalled EMEA deals." },
    { id: n.n_mer847,      org_id: orgId, label: "MER-847 P0 Incident",     entity_type: "decision",   visibility: "org_wide",    description: "P0 payment service outage May 20. 35 min downtime, 847 failures. Resolved. Connection pool 20→50.", temporal_metadata: { occurred_at: "2026-05-20T14:23:00Z" } },
    { id: n.n_sync_engine, org_id: orgId, label: "SmartSync Sync Engine",   entity_type: "component",  visibility: "org_wide",    description: "Core engine merged PR #1876. Event sourcing + vector clock conflict resolution. p99 340ms in staging." },
    { id: n.n_dbt,         org_id: orgId, label: "dbt Pipeline",            entity_type: "service",    visibility: "org_wide",    description: "dbt models on 2-hour QStash schedule feeding Snowflake analytics warehouse." },
    { id: n.n_sso,         org_id: orgId, label: "SSO/SAML Integration",   entity_type: "concept",    visibility: "org_wide",    description: "Enterprise SSO requested by 3 customers in May 2026. Not on Q2 roadmap. Flagged for Q3. MER-920." },
    { id: n.n_board,       org_id: orgId, label: "Board Deck June 2026",    entity_type: "concept",    visibility: "org_wide",    description: "Board meeting June 3 2026. Asks: Series A approval, EMEA recovery review. SmartSync as growth story." },
  ];

  for (const node of nodes) {
    await db.from("kg_nodes").upsert({
      id: node.id,
      org_id: node.org_id,
      label: node.label,
      entity_type: node.entity_type,
      visibility: node.visibility,
      description: node.description,
      department_ids: [],
      temporal_metadata: (node as any).temporal_metadata ?? null,
      metadata: {},
    }, { onConflict: "id" }).throwOnError();
  }
  log(`✓ ${nodes.length} KG nodes`);

  const edges = [
    { id: n.e1,  source_node: n.n_smartsync,   target_node: n.n_auth_v2,     relation: "DEPENDS_ON",  provenance: "EXTRACTED" },
    { id: n.e2,  source_node: n.n_smartsync,   target_node: n.n_sync_engine, relation: "USES",        provenance: "EXTRACTED" },
    { id: n.e3,  source_node: n.n_launch,      target_node: n.n_auth_v2,     relation: "DEPENDS_ON",  provenance: "EXTRACTED" },
    { id: n.e4,  source_node: n.n_payment_svc, target_node: n.n_mer847,      relation: "RELATED_TO",  provenance: "EXTRACTED" },
    { id: n.e5,  source_node: n.n_priya,       target_node: n.n_smartsync,   relation: "OWNS",        provenance: "EXTRACTED" },
    { id: n.e6,  source_node: n.n_alex,        target_node: n.n_auth_v2,     relation: "OWNS",        provenance: "EXTRACTED" },
    { id: n.e7,  source_node: n.n_eng_team,    target_node: n.n_auth_v2,     relation: "OWNS",        provenance: "EXTRACTED" },
    { id: n.e8,  source_node: n.n_eng_team,    target_node: n.n_payment_svc, relation: "OWNS",        provenance: "EXTRACTED" },
    { id: n.e9,  source_node: n.n_smartsync,   target_node: n.n_snowflake,   relation: "USES",        provenance: "INFERRED",  confidence: 0.85 },
    { id: n.e10, source_node: n.n_dbt,         target_node: n.n_snowflake,   relation: "FEEDS",       provenance: "EXTRACTED" },
    { id: n.e11, source_node: n.n_sarah,       target_node: n.n_pricing,     relation: "OWNS",        provenance: "EXTRACTED" },
    { id: n.e12, source_node: n.n_marcus,      target_node: n.n_emea_pipe,   relation: "OWNS",        provenance: "EXTRACTED" },
    { id: n.e13, source_node: n.n_soc2,        target_node: n.n_techcorp,    relation: "RELATED_TO",  provenance: "EXTRACTED" },
    { id: n.e14, source_node: n.n_sales_team,  target_node: n.n_emea_pipe,   relation: "OWNS",        provenance: "EXTRACTED" },
    { id: n.e15, source_node: n.n_board,       target_node: n.n_emea_pipe,   relation: "MENTIONS",    provenance: "EXTRACTED" },
    { id: n.e16, source_node: n.n_sso,         target_node: n.n_techcorp,    relation: "RELATED_TO",  provenance: "EXTRACTED" },
  ];

  for (const edge of edges) {
    await db.from("kg_edges").upsert({
      id: edge.id,
      org_id: orgId,
      source_node: edge.source_node,
      target_node: edge.target_node,
      relation: edge.relation,
      provenance: edge.provenance,
      confidence: (edge as any).confidence ?? 1.0,
      visibility: "org_wide",
      metadata: {},
    }, { onConflict: "id" }).throwOnError();
  }
  log(`✓ ${edges.length} KG edges`);

  const n2 = D.kg;
  const events = [
    { id: n2.ev1,  entity_id: n2.n_payment_svc, event_type: "incident",   event_time: "2026-05-20T14:23:00Z", description: "P0 incident MER-847: Payment service p99 latency spiked to 8.2s, affecting all customer checkout flows. 847 transactions failed." },
    { id: n2.ev2,  entity_id: n2.n_payment_svc, event_type: "change",     event_time: "2026-05-20T14:58:00Z", description: "P0 MER-847 resolved: PostgreSQL connection pool max increased from 20 to 50. Incident duration 35 minutes.", caused_by_event_id: n2.ev1 },
    { id: n2.ev3,  entity_id: n2.n_pricing,     event_type: "decision",   event_time: "2026-04-28T16:00:00Z", description: "Decision: Usage-based pricing adopted effective May 1 2026. $0.15/API call + $299/seat minimum. Unanimous approval by Sarah Chen, Marcus Reid, Priya Nair." },
    { id: n2.ev4,  entity_id: n2.n_sync_engine, event_type: "milestone",  event_time: "2026-05-26T17:30:00Z", description: "SmartSync core sync engine merged (PR #1876). Event sourcing architecture. p99 340ms in staging — within 500ms SLO." },
    { id: n2.ev5,  entity_id: n2.n_snowflake,   event_type: "decision",   event_time: "2026-02-10T10:00:00Z", description: "Decision: Migrate analytics from PostgreSQL OLAP to Snowflake. Approved by Alex Kumar. Expected query time improvement: 90%." },
    { id: n2.ev6,  entity_id: n2.n_snowflake,   event_type: "milestone",  event_time: "2026-03-12T12:00:00Z", description: "Snowflake migration complete. PR #1721 merged. Query time: 45.2s → 2.7s (94% improvement). dbt pipelines live.", caused_by_event_id: n2.ev5 },
    { id: n2.ev7,  entity_id: n2.n_emea_pipe,   event_type: "alert",      event_time: "2026-05-22T09:00:00Z", description: "EMEA pipeline dropped 23% in 5 weeks ($2.39M → $1.84M). $520K at risk: TechCorp UK $280K, Infratek DE $145K, Nordex FI $95K." },
    { id: n2.ev8,  entity_id: n2.n_auth_v2,     event_type: "escalation", event_time: "2026-05-28T10:00:00Z", description: "Auth v2 (PR #1901) escalated: blocking SmartSync launch and data platform. Must merge by June 3 or June 15 launch at risk.", caused_by_event_id: n2.ev4 },
    { id: n2.ev9,  entity_id: n2.n_launch,      event_type: "decision",   event_time: "2026-05-15T00:00:00Z", description: "Decision: SmartSync launch date set to June 15 2026. 12 enterprise design partners committed. Announcement to go out June 1." },
    { id: n2.ev10, entity_id: n2.n_techcorp,    event_type: "alert",      event_time: "2026-05-19T14:00:00Z", description: "TechCorp UK deal ($280K) stalled at 47 days in negotiation. Blocking factors: SOC2 certification gap and invoice EUR formatting bug (MER-889)." },
    { id: n2.ev11, entity_id: n2.n_soc2,        event_type: "milestone",  event_time: "2026-04-15T09:00:00Z", description: "SOC 2 Type II audit preparation started. Schellman & Company engaged. Audit window: July 1–August 31 2026. Vanta deployed." },
    { id: n2.ev12, entity_id: n2.n_eng_team,    event_type: "decision",   event_time: "2026-04-30T16:00:00Z", description: "Decision: Hire 2 senior backend engineers in Q2 2026. JDs posted. Approved by Alex Kumar and Sarah Chen." },
    { id: n2.ev13, entity_id: n2.n_payment_svc, event_type: "change",     event_time: "2026-05-20T16:02:00Z", description: "Payment service hotfix deployed to production (PR #1847). Connection pool max 20→50. Load test confirmed zero failures at 5x normal concurrency." },
    { id: n2.ev14, entity_id: n2.n_emea_pipe,   event_type: "incident",   event_time: "2026-05-15T11:00:00Z", description: "EMEA invoice currency formatting bug MER-889 discovered. EUR decimals displaying incorrectly for DE, FI, SE customers. TechCorp UK dispute filed May 18." },
    { id: n2.ev15, entity_id: n2.n_smartsync,   event_type: "milestone",  event_time: "2026-05-28T00:00:00Z", description: "SmartSync NPS from beta program: 71. All-time company NPS: 47 (up from 38 in Q1). SmartSync beta users: 124 of 200 target." },
  ];

  for (const ev of events) {
    await db.from("kg_events").upsert({
      id: ev.id,
      org_id: orgId,
      entity_id: ev.entity_id,
      event_type: ev.event_type,
      event_time: ev.event_time,
      description: ev.description,
      caused_by_event_id: (ev as any).caused_by_event_id ?? null,
      confidence: 1.0,
      metadata: {},
    }, { onConflict: "id" }).throwOnError();
  }
  log(`✓ ${events.length} KG events`);
}

async function seedWatchlists(orgId: string, memberId: string) {
  const watchlists = [
    {
      id: D.watchlists.emea,
      name: "EMEA Pipeline Health",
      query: "What is the current EMEA sales pipeline status? Are there any at-risk deals and what are the blockers?",
      schedule: "0 9 * * 1-5",
      last_answer: "EMEA pipeline stands at $1.84M, down 23% from $2.39M in April. Three deals are stalled totalling $520K at risk: TechCorp UK ($280K) blocked on SOC 2 certification, Infratek DE ($145K) under procurement freeze, Nordex FI ($95K) champion departed. Win rate EMEA 22% vs 31% global. Coverage ratio 2.8x against 3.5x target. EMEA recovery plan drafted May 27 — executive rescue calls scheduled this week.",
      last_answer_hash: "emea-hash-2026-05-29",
      notify_channels: [{ type: "in_app" }],
    },
    {
      id: D.watchlists.auth,
      name: "Auth v2 Upgrade Status",
      query: "What is the current status of the auth service v2 upgrade? Are there any blockers or risks to the SmartSync launch?",
      schedule: "0 9 * * 1-5",
      last_answer: "Auth service v2 (PR #1901) remains open with CI failing — integration tests need Vault token unavailable in GitHub Actions. 3 reviewers requested but not yet assigned. This is the critical blocker for SmartSync June 15 launch. If not merged by June 3, the launch date is at risk. Alex Kumar escalated to engineering all-hands. Data platform OAuth (MER-878) and SmartSync billing (MER-912) are also blocked.",
      last_answer_hash: "auth-hash-2026-05-29",
      notify_channels: [{ type: "in_app" }],
    },
    {
      id: D.watchlists.smartsync,
      name: "SmartSync Launch Readiness",
      query: "Is SmartSync on track for the June 15 launch? What is the completion status and are there any risks?",
      schedule: "0 8 * * 1-5",
      last_answer: "SmartSync launch June 15 is at moderate risk. Core sync engine merged (PR #1876, p99 340ms). UI components 80% done. QA starts June 1. Critical dependency: auth-v2 (PR #1901) must merge by June 3 — currently blocked on CI failure. Documentation not started. Billing integration blocked on auth-v2. 12 design partners committed to June 15 availability. If auth-v2 slips past June 3, recommend escalating to delay launch 1 week.",
      last_answer_hash: "smartsync-hash-2026-05-29",
      notify_channels: [{ type: "in_app" }],
    },
    {
      id: D.watchlists.eng_health,
      name: "Engineering P0/P1 Health",
      query: "Are there any open P0 or P1 incidents or critical blockers in engineering right now?",
      schedule: "0 8 * * *",
      last_answer: "No active P0 incidents. MER-847 payment service P0 resolved May 20 (35min downtime, post-mortem scheduled May 24). Active P1: MER-901 auth service v2 upgrade — blocking SmartSync launch and two teams, ETA June 3. P1 attention required: PR #1901 needs 3 reviewers urgently. No other P0 or P1 incidents open. Monitoring nominal.",
      last_answer_hash: "eng-hash-2026-05-29",
      notify_channels: [{ type: "in_app" }],
    },
  ];

  for (const w of watchlists) {
    await db.from("watchlists").upsert({
      id: w.id,
      org_id: orgId,
      user_id: memberId,
      name: w.name,
      query: w.query,
      schedule: w.schedule,
      last_run_at: new Date(Date.now() - 3600000).toISOString(),
      last_answer: w.last_answer,
      last_answer_hash: w.last_answer_hash,
      last_cited_sources: [],
      notify_channels: w.notify_channels,
      is_active: true,
    }, { onConflict: "id" }).throwOnError();
  }
  log(`✓ 4 watchlists`);

  const alerts = [
    {
      id: D.alerts.emea,
      watchlist_id: D.watchlists.emea,
      previous_answer: "EMEA pipeline at $2.39M with 8 active deals. Win rate 28%. Pipeline coverage 3.7x against Q2 target.",
      new_answer: "EMEA pipeline dropped to $1.84M — a 23% decrease in 5 weeks. $520K at risk: TechCorp UK $280K (SOC2 blocker), Infratek DE $145K (procurement freeze), Nordex FI $95K (champion departed). Win rate fell to 22%. Coverage ratio 2.8x — below 3.5x target.",
      change_summary: "EMEA pipeline dropped 23% ($550K reduction). Three enterprise deals totalling $520K now at risk. Win rate declined 6 points. Coverage ratio below target.",
      severity: "critical",
    },
    {
      id: D.alerts.auth,
      watchlist_id: D.watchlists.auth,
      previous_answer: "Auth v2 PR #1901 open, reviewing in progress. 1 of 3 reviewers approved. CI partially passing.",
      new_answer: "Auth v2 PR #1901 CI failing: integration tests need Vault token not available in GitHub Actions. 0 of 3 reviewers approved. SmartSync launch June 15 is now at risk. Must merge by June 3 — 6 days remaining.",
      change_summary: "Auth v2 upgrade status worsened — CI now failing, no reviewers assigned, SmartSync launch window at risk.",
      severity: "warning",
    },
  ];

  for (const a of alerts) {
    await db.from("watchlist_alerts").upsert({
      id: a.id,
      watchlist_id: a.watchlist_id,
      org_id: orgId,
      user_id: memberId,
      previous_answer: a.previous_answer,
      new_answer: a.new_answer,
      change_summary: a.change_summary,
      severity: a.severity,
      cited_sources: [],
      is_read: false,
      created_at: new Date(Date.now() - 7200000).toISOString(),
    }, { onConflict: "id" }).throwOnError();
  }
  log(`✓ 2 watchlist alerts (EMEA pipeline critical, Auth v2 warning)`);
}

async function seedBriefing(orgId: string, memberId: string) {
  await db.from("automations").upsert({
    id: D.automation,
    org_id: orgId,
    user_id: memberId,
    type: "morning_briefing",
    status: "active",
    config: { delivery: "in_app", include_graph: true },
    cron_expression: "0 7 * * *",
    last_run_at: new Date().toISOString(),
    last_run_status: "ok",
    run_count: 47,
  }, { onConflict: "org_id,user_id,type" }).throwOnError();

  const briefingContent = {
    calendar: "No calendar connected — consider linking Google Calendar for meeting context. Key scheduled event: Board meeting June 3.",
    emails: "No email connected — consider linking Gmail for email context. Key context from docs: EMEA recovery plan due May 30, board deck submission deadline approaching.",
    docs: "5 key updates this week: EMEA Q2 Recovery Plan drafted (May 27) — $520K at risk, 3 stalled deals, executive actions required. Board Deck updated (May 28) — June 3 meeting, Series A discussion and EMEA recovery on agenda. SmartSync Status (May 28) — core engine merged, UI 80%, auth-v2 critical path. Auth v2 PR #1901 (May 28) — CI failing, blocking SmartSync launch. Payment service post-mortem scheduled May 24 following P0 MER-847.",
    knowledge: "🔴 CRITICAL: EMEA pipeline down 23% — $520K at risk (TechCorp UK $280K, Infratek DE $145K, Nordex FI $95K). Executive rescue calls needed this week. 🔴 BLOCKER: Auth v2 PR #1901 must merge by June 3 or SmartSync June 15 launch is at risk — no reviewers assigned yet. 🟡 Board meeting June 3 — EMEA recovery plan and Series A ask both on agenda. SOC2 directly unblocks TechCorp UK deal. ✅ NPS at all-time high 47. SmartSync core engine merged successfully.",
    section_status: { calendar: "no_data", emails: "no_data", docs: "ok", knowledge: "ok" },
  };

  await db.from("briefings").upsert({
    id: D.briefing,
    org_id: orgId,
    user_id: memberId,
    automation_id: D.automation,
    content: briefingContent,
    summary: "EMEA pipeline down 23% ($520K at risk). Auth v2 blocking SmartSync launch — needs reviewers today. Board meeting June 3 with Series A ask. SOC2 unblocks TechCorp UK $280K deal.",
    calendar_items: 0,
    email_items: 0,
    doc_items: 5,
    generated_at: new Date().toISOString(),
    delivered: false,
    delivery_method: "in_app",
  }, { onConflict: "id" }).throwOnError();

  log(`✓ Briefing + automation (today's morning brief with live company context)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🚀 Athene Demo Seed — Meridian Labs\n");

  // Resolve org
  const forcedOrgId = process.env.DEMO_ORG_ID;
  let orgId: string;
  let memberId: string;

  if (forcedOrgId) {
    orgId = forcedOrgId;
    const { data: m } = await db.from("org_members").select("id").eq("org_id", orgId).eq("clerk_user_id", REAL_CLERK_USER_ID).single();
    if (!m) { console.error(`❌  No org_member found for clerk_user_id in org ${orgId}`); process.exit(1); }
    memberId = m.id;
    console.log(`Using provided DEMO_ORG_ID: ${orgId}`);
  } else {
    const { data: m } = await db.from("org_members").select("id, org_id").eq("clerk_user_id", REAL_CLERK_USER_ID).limit(1).single();
    if (!m) { console.error(`❌  No org found for clerk_user_id ${REAL_CLERK_USER_ID}. Set DEMO_ORG_ID env var.`); process.exit(1); }
    orgId = m.org_id;
    memberId = m.id;
    console.log(`Auto-detected org: ${orgId}`);
  }

  console.log(`Member ID: ${memberId}\n`);

  try {
    await seedDepartments(orgId);
    await seedConnections(orgId, memberId);
    await seedDocuments(orgId, memberId);
    await seedKnowledgeGraph(orgId);
    await seedWatchlists(orgId, memberId);
    await seedBriefing(orgId, memberId);
  } catch (err) {
    console.error("\n❌ Seed failed:", err);
    process.exit(1);
  }

  console.log("\n✅ Demo seed complete!\n");
  console.log("What was seeded:");
  console.log("  • 5 departments (Engineering, Product, Sales, Operations, Executive)");
  console.log("  • 5 connections (Slack, Jira, GitHub, Snowflake, Google Drive) — all active");
  console.log("  • 28 documents with real 768-dim Jina embeddings across all sources");
  console.log("  • 20 KG nodes, 16 edges, 15 events (incidents, decisions, milestones)");
  console.log("  • 4 watchlists with pre-computed answers");
  console.log("  • 2 triggered alerts (EMEA pipeline critical, Auth v2 warning)");
  console.log("  • 1 morning briefing (ready to view on /briefing)");
  console.log("\nDemo narratives available:");
  console.log("  • Ask: 'What engineering decisions did we make last week?'");
  console.log("  • Ask: 'What is blocking the SmartSync launch?'");
  console.log("  • Ask: 'What is happening with the EMEA pipeline?'");
  console.log("  • Ask: 'What are the open P0 and P1 issues?'");
  console.log("  • Ask: 'What decisions did we make in Q1 and Q2?'");
  console.log("  • Ask: 'Why did we change pricing to usage-based?'");
  console.log("  • Ask: 'What is the status of SOC 2 certification?'");
  console.log("  • Ask: 'What changed in EMEA pipeline this month?'");
  console.log("");
}

main();
