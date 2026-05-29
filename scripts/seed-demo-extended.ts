#!/usr/bin/env tsx
/**
 * scripts/seed-demo-extended.ts
 *
 * Adds ~60 short, dense, targeted documents to the Meridian Labs demo dataset.
 * These are designed to rank high in vector search for the key demo queries:
 *   - "What is blocking TechCorp UK from closing?"
 *   - "What is blocking the SmartSync launch?"
 *   - "What happened with the payment service?"
 *   - "What decisions did we make this month?"
 *   - "What is the EMEA pipeline status?"
 *   - "Who is responsible for X?"
 *
 * Run AFTER seed-demo.ts:
 *   npx tsx scripts/seed-demo-extended.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const SUPABASE_URL         = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const JINA_API_KEY         = process.env.JINA_API_KEY ?? "";
const REAL_CLERK_USER_ID   = "user_3DghfV8knOaC724syP31F8SiYlA";

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// Reuse same connection IDs from seed-demo.ts
const CONNS = {
  slack:     "d3000000-0000-0000-0002-000000000001",
  jira:      "d3000000-0000-0000-0002-000000000002",
  github:    "d3000000-0000-0000-0002-000000000003",
  snowflake: "d3000000-0000-0000-0002-000000000004",
  gdrive:    "d3000000-0000-0000-0002-000000000005",
};

const DEPTS = {
  engineering: "d3000000-0000-0000-0001-000000000001",
  product:     "d3000000-0000-0000-0001-000000000002",
  sales:       "d3000000-0000-0000-0001-000000000003",
  operations:  "d3000000-0000-0000-0001-000000000004",
  executive:   "d3000000-0000-0000-0001-000000000005",
};

// ID prefix for extended docs: d3000000-0000-0000-00EX-XXXXXXXXXXXX
function xid(n: number) {
  return `d3000000-0000-0000-00e0-${String(n).padStart(12, "0")}`;
}

interface ExtDoc {
  id: string;
  connId: string;
  sourceType: string;
  title: string;
  externalId: string;
  dept: string | null;
  visibility: string;
  text: string;
  url: string;
  createdAt: string;
}

const EXTENDED_DOCS: ExtDoc[] = [
  // ─── TECHCORP UK DEAL (7 docs) ─────────────────────────────────────────────
  {
    id: xid(1),
    connId: CONNS.slack, sourceType: "slack",
    title: "#sales — TechCorp UK deal is blocked on SOC 2",
    externalId: "x-slack-techcorp-soc2-block",
    dept: DEPTS.sales, visibility: "department",
    url: "https://meridian.slack.com/archives/C_SALES/p1716390000",
    createdAt: "2026-05-22T10:00:00Z",
    text: "TechCorp UK update: deal is completely blocked on SOC 2 Type II certification. Their procurement team sent an official email — they cannot sign any contract above £50K without a valid SOC 2 report. We don't have it. Jordan Lee is the person responsible for SOC 2 at Meridian — it's in progress (MER-750) but the audit window doesn't start until July 1. Marcus Reid is the account owner for TechCorp UK. The deal is worth $280K ARR. Sarah Chen is aware and will call TechCorp UK CTO directly this week.",
  },
  {
    id: xid(2),
    connId: CONNS.slack, sourceType: "slack",
    title: "#sales — TechCorp UK invoice dispute blocking renewal",
    externalId: "x-slack-techcorp-invoice",
    dept: DEPTS.sales, visibility: "department",
    url: "https://meridian.slack.com/archives/C_SALES/p1716476400",
    createdAt: "2026-05-23T09:00:00Z",
    text: "Second blocker on TechCorp UK: they filed a formal billing dispute on May 18 because the EUR decimal separator on their invoices shows a period instead of a comma (German locale). This is bug MER-889, owned by Kai Mueller in engineering, ETA June 2. Until the invoice formatting is fixed and the disputed invoices are reissued, their finance team won't release the renewal PO. So TechCorp UK has two blockers: SOC 2 certification (owner: Jordan Lee) and invoice formatting bug (owner: Kai Mueller, ETA June 2).",
  },
  {
    id: xid(3),
    connId: CONNS.jira, sourceType: "jira",
    title: "MER-905: TechCorp UK deal — blockers and recovery actions",
    externalId: "x-jira-MER-905",
    dept: DEPTS.sales, visibility: "department",
    url: "https://meridian.atlassian.net/browse/MER-905",
    createdAt: "2026-05-22T14:00:00Z",
    text: "MER-905 — TechCorp UK enterprise deal recovery. Deal owner: Marcus Reid. Deal value: $280K ARR. Status: BLOCKED. Two blockers preventing close: 1) SOC 2 Type II certification required by TechCorp UK procurement for all contracts above £50K. Meridian does not yet have SOC 2 certification. Jordan Lee owns SOC 2 preparation (MER-750), audit window July 1–August 31 2026. Interim mitigation: provide completed security questionnaire and pen test report by June 15. 2) Invoice EUR formatting bug MER-889 — TechCorp UK filed billing dispute, blocking PO release. Kai Mueller fixing by June 2. Action items: Sarah Chen calls TechCorp CTO this week. Marcus Reid to provide interim security questionnaire by June 10.",
  },
  {
    id: xid(4),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "TechCorp UK — Account Notes and Deal Status",
    externalId: "x-gdrive-techcorp-notes",
    dept: DEPTS.sales, visibility: "department",
    url: "https://drive.google.com/file/d/meridian-techcorp-uk-notes",
    createdAt: "2026-05-24T11:00:00Z",
    text: "TechCorp UK account notes — May 2026. Company: TechCorp UK Ltd, 400 employees, London. Champion: David Morrison, Head of Engineering. Budget holder: Alison Clarke, VP IT. Deal value: $280K ARR. Current status: blocked at negotiation stage for 47 days. Primary blocker: TechCorp procurement policy requires SOC 2 Type II certification for enterprise software contracts above £50K. Meridian does not currently hold SOC 2 certification. Secondary blocker: 3 months of invoices with incorrect EUR decimal formatting have triggered a billing dispute — finance will not release PO until resolved. Who is responsible: Marcus Reid is account owner, Jordan Lee owns SOC 2 unblock, Kai Mueller owns invoice fix, Sarah Chen is executive sponsor.",
  },
  {
    id: xid(5),
    connId: CONNS.slack, sourceType: "slack",
    title: "#exec — TechCorp UK is our biggest enterprise blocker right now",
    externalId: "x-slack-techcorp-exec",
    dept: DEPTS.executive, visibility: "department",
    url: "https://meridian.slack.com/archives/C_EXEC/p1716562800",
    createdAt: "2026-05-24T09:00:00Z",
    text: "Sarah Chen: TechCorp UK ($280K) is our single largest stalled deal. Here is exactly what is blocking it and who is accountable: 1) SOC 2 Type II — Jordan Lee owns this, audit starts July 1. Until then, Marcus Reid will get TechCorp UK an interim pen test report and completed security questionnaire by June 10 to satisfy procurement. 2) Invoice bug — Kai Mueller fixing the EUR decimal format by June 2, then we reissue the disputed invoices. I am calling David Morrison (their CTO) on Tuesday. If we unblock these two items, this deal closes in June.",
  },
  {
    id: xid(6),
    connId: CONNS.snowflake, sourceType: "snowflake",
    title: "crm_deals_at_risk — TechCorp UK deal record",
    externalId: "x-snow-crm-techcorp",
    dept: DEPTS.sales, visibility: "bi_accessible",
    url: "https://app.snowflake.com/meridian/crm_deals_at_risk",
    createdAt: "2026-05-29T06:00:00Z",
    text: "Snowflake CRM table crm_deals_at_risk — TechCorp UK record. Account: TechCorp UK Ltd. ARR: $280,000. Stage: Negotiation (stuck 47 days). Owner: Marcus Reid. Blockers: [1] SOC 2 Type II certification not available — procurement requirement for contracts >£50K. Responsible: Jordan Lee. ETA: Q3 2026 or interim security questionnaire by June 10. [2] Invoice formatting dispute — EUR decimal bug MER-889. Responsible: Kai Mueller. ETA: June 2. [3] SSO/SAML not available — IT department requirement (MER-920). Next actions: CEO exec call scheduled, interim pen test report to be delivered, invoice fix ETA June 2. Risk score: HIGH. Expected close date if unblocked: June 30 2026.",
  },
  {
    id: xid(7),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "EMEA At-Risk Deals — Individual Deal Summaries",
    externalId: "x-gdrive-emea-deals",
    dept: DEPTS.sales, visibility: "department",
    url: "https://drive.google.com/file/d/meridian-emea-at-risk-deals",
    createdAt: "2026-05-27T14:00:00Z",
    text: "EMEA at-risk deals summary May 2026. Deal 1: TechCorp UK $280K. Blocked by: SOC 2 certification (owner: Jordan Lee) and invoice EUR bug (owner: Kai Mueller). Account owner: Marcus Reid. Executive sponsor: Sarah Chen. Deal 2: Infratek DE $145K. Blocked by: company-wide procurement freeze until Q3 2026. Champion still engaged. Action: exec-to-exec call June 2, custom contract terms with delayed billing. Deal 3: Nordex FI $95K. Blocked by: champion Sara Mäkinen left the company. Action: identify new champion via LinkedIn, offer SmartSync beta access. Total at risk: $520K. EMEA win rate: 22% vs global 31%. Pipeline: $1.84M vs $2.39M in April (-23%).",
  },

  // ─── SMARTSYNC LAUNCH BLOCKERS (6 docs) ────────────────────────────────────
  {
    id: xid(10),
    connId: CONNS.slack, sourceType: "slack",
    title: "#engineering — SmartSync is blocked on auth-v2, what needs to happen",
    externalId: "x-slack-smartsync-blocked",
    dept: DEPTS.engineering, visibility: "department",
    url: "https://meridian.slack.com/archives/C_ENG/p1716976800",
    createdAt: "2026-05-29T09:00:00Z",
    text: "SmartSync launch June 15 is at serious risk. Here is exactly what is blocking it and who needs to act: The auth-v2 PR #1901 must be merged by June 3 — that is the hard deadline. Without auth-v2, SmartSync UI cannot render the new JWT claims, and billing cannot count sync events. PR #1901 is owned by Dmitri Volkov. The CI is failing because the integration test suite needs a Vault dev token that is not available in GitHub Actions. Alex Kumar needs to fix the Vault token in CI. Three reviewers are needed: alex-kumar, praveenk, and eleanor-chan. Nobody has reviewed yet. If auth-v2 does not merge by June 3, the recommendation is to delay SmartSync launch by 1 week to June 22.",
  },
  {
    id: xid(11),
    connId: CONNS.jira, sourceType: "jira",
    title: "MER-901 blocker summary — what is blocking SmartSync launch",
    externalId: "x-jira-MER-901-summary",
    dept: DEPTS.engineering, visibility: "org_wide",
    url: "https://meridian.atlassian.net/browse/MER-901",
    createdAt: "2026-05-28T16:00:00Z",
    text: "MER-901 is the critical blocker for SmartSync June 15 launch. Auth service v2 upgrade must complete by June 3 or launch is at risk. What is blocked by auth-v2: SmartSync UI components (MER-856) cannot merge without new JWT claims. SmartSync billing integration (MER-912) cannot count sync events without new auth token structure. Data platform OAuth (MER-878) is also blocked. Who is responsible: Dmitri Volkov owns PR #1901 (author). Alex Kumar must fix the Vault CI issue. Three reviewers needed urgently: alex-kumar, praveenk, eleanor-chan. Current CI status: 2 of 4 checks failing. Days until deadline: 6 days from May 28.",
  },
  {
    id: xid(12),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "SmartSync Launch Risk Register — May 28 2026",
    externalId: "x-gdrive-smartsync-risks",
    dept: DEPTS.product, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-smartsync-risk-register",
    createdAt: "2026-05-28T12:00:00Z",
    text: "SmartSync launch risk register as of May 28 2026. Risk 1 — CRITICAL: Auth-v2 (PR #1901) must merge by June 3. Owner: Dmitri Volkov (PR author), Alex Kumar (CI fix needed), reviewers needed: praveenk, eleanor-chan. Current status: CI failing, 0 reviewers assigned. Risk 2 — HIGH: Documentation not started. Owner: technical writing team. Risk 3 — MEDIUM: SmartSync UI components 80% done. Owner: frontend team, ETA May 31. Risk 4 — MEDIUM: QA environment not yet configured. Owner: QA team, starts June 1. Risk 5 — LOW: Billing integration (MER-912) blocked on auth-v2, same critical path. 12 enterprise design partners waiting for June 15. If Risk 1 is not resolved by June 3, launch delay of minimum 1 week recommended.",
  },
  {
    id: xid(13),
    connId: CONNS.slack, sourceType: "slack",
    title: "#product — SmartSync critical path and who owns each piece",
    externalId: "x-slack-smartsync-owners",
    dept: DEPTS.product, visibility: "org_wide",
    url: "https://meridian.slack.com/archives/C_PROD/p1716976900",
    createdAt: "2026-05-29T10:00:00Z",
    text: "SmartSync ownership breakdown for the June 15 launch. Core sync engine: DONE — merged by Priya Nair (PR #1876). Auth-v2 dependency: BLOCKING — Dmitri Volkov owns PR #1901, Alex Kumar must fix CI, needs reviewers. SmartSync UI: 80% done — frontend team, ETA May 31. QA and testing: NOT STARTED — QA team starts June 1. Documentation: NOT STARTED — technical writing, needs to start immediately. Billing integration: BLOCKED on auth-v2 — platform-billing team. The single most important action right now: assign 3 reviewers to PR #1901 today and fix the Vault CI token issue.",
  },
  {
    id: xid(14),
    connId: CONNS.github, sourceType: "github",
    title: "PR #1901 — Review request urgent, blocking SmartSync launch June 15",
    externalId: "x-github-pr-1901-urgent",
    dept: DEPTS.engineering, visibility: "department",
    url: "https://github.com/meridian-labs/auth-service/pull/1901",
    createdAt: "2026-05-28T18:00:00Z",
    text: "PR #1901 auth-service-v2 — URGENT review request. This PR is blocking the SmartSync June 15 launch. Must merge by June 3 (6 days). Author: dmitri-volkov. CI failure: integration-tests failing because Vault dev token is not configured in GitHub Actions secrets. Alex Kumar needs to add VAULT_DEV_TOKEN to GitHub Actions secrets for the auth-service repo. Reviewers requested: alex-kumar, praveenk, eleanor-chan — nobody has reviewed yet as of May 28. Changes: 847 lines, 23 files. New JWT claim schema, PKCE OAuth2 flow, token refresh endpoint. Backward compatible — existing tokens continue to work for 90 days. This is on the critical path for SmartSync, data platform OAuth, and billing.",
  },
  {
    id: xid(15),
    connId: CONNS.slack, sourceType: "slack",
    title: "#engineering — Auth v2 CI fix needed, Vault token missing in GitHub Actions",
    externalId: "x-slack-auth-ci-fix",
    dept: DEPTS.engineering, visibility: "department",
    url: "https://meridian.slack.com/archives/C_ENG/p1716890200",
    createdAt: "2026-05-28T11:00:00Z",
    text: "Auth v2 PR #1901 CI is failing because the integration test suite uses Vault to fetch test credentials, but the VAULT_DEV_TOKEN secret is not configured in GitHub Actions for the auth-service repository. Alex Kumar is the only person with admin access to the auth-service GitHub repo secrets. He needs to add VAULT_DEV_TOKEN to GitHub Actions secrets today. Once that is done, CI should pass and we can get the 3 required reviewers to approve. This is the last remaining blocker before PR #1901 can merge. Time-sensitive — June 3 deadline for SmartSync launch.",
  },

  // ─── PAYMENT SERVICE / MER-847 INCIDENT (5 docs) ──────────────────────────
  {
    id: xid(20),
    connId: CONNS.slack, sourceType: "slack",
    title: "#engineering — MER-847 post-mortem and root cause",
    externalId: "x-slack-mer847-postmortem",
    dept: DEPTS.engineering, visibility: "department",
    url: "https://meridian.slack.com/archives/C_ENG/p1716562800",
    createdAt: "2026-05-24T14:00:00Z",
    text: "MER-847 post-mortem completed May 24. Root cause: PostgreSQL connection pool max was set to 20. Deploy v2.4.1 on May 20 added 3 new database queries per payment request, increasing per-request DB load by 40%. Under normal traffic, all 20 connections were consumed, causing new requests to queue and time out. Result: p99 latency spiked to 8.2 seconds, 847 checkout transactions failed over 35 minutes. Fix applied: pool.max increased from 20 to 50, connectionTimeoutMillis reduced to 3 seconds. Who is responsible: Alex Kumar owned the incident response and fix. Action items: add connection pool exhaustion alert to Datadog (owner: alex-kumar), mandatory load testing in staging before all production deploys (owner: eng-leads), review all services for similar pool config issues (owner: dmitri-volkov).",
  },
  {
    id: xid(21),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Post-Mortem Report — MER-847 Payment Service P0 Incident",
    externalId: "x-gdrive-mer847-postmortem",
    dept: DEPTS.engineering, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-mer847-postmortem",
    createdAt: "2026-05-24T16:00:00Z",
    text: "Post-Mortem: MER-847 Payment Service P0 Incident — May 20 2026. Incident owner: Alex Kumar. Duration: 35 minutes (14:23–14:58 UTC). Customer impact: 847 checkout transactions failed, affecting all customers during the incident window. Root cause: PostgreSQL connection pool max=20 was insufficient after deploy v2.4.1 added 3 new DB queries per request. Contributing factor: no connection pool monitoring in Datadog prior to incident. Resolution: hotfix PR #1847 deployed — pool max increased to 50. Follow-up actions: 1) Datadog connection pool alert (Alex Kumar, due June 3). 2) Mandatory staging load test before production deploys (Eng leads, due June 7). 3) Audit all 12 services for connection pool sizing (Dmitri Volkov, due June 14). Blameless: the pool limit was never reviewed as traffic grew from the initial configuration.",
  },
  {
    id: xid(22),
    connId: CONNS.slack, sourceType: "slack",
    title: "#engineering — What caused the payment outage on May 20",
    externalId: "x-slack-mer847-cause",
    dept: DEPTS.engineering, visibility: "org_wide",
    url: "https://meridian.slack.com/archives/C_ENG/p1716217200",
    createdAt: "2026-05-20T15:00:00Z",
    text: "For anyone asking what caused the payment service outage today (May 20): The payment service uses a PostgreSQL connection pool with a max of 20 connections. The deploy at 14:15 UTC added new database queries per request. Under load, all 20 connections were exhausted and new checkout requests started failing immediately. Alex Kumar identified the root cause at 14:40, deployed the fix (pool max to 50) by 14:58. The payment service is responsible for processing all customer checkouts. It depends on PostgreSQL for transaction storage. The incident lasted 35 minutes and caused 847 checkout failures. Alex Kumar is the on-call engineer and incident commander.",
  },
  {
    id: xid(23),
    connId: CONNS.jira, sourceType: "jira",
    title: "MER-847 incident timeline — payment service P0 resolved",
    externalId: "x-jira-MER-847-timeline",
    dept: DEPTS.engineering, visibility: "org_wide",
    url: "https://meridian.atlassian.net/browse/MER-847",
    createdAt: "2026-05-20T15:30:00Z",
    text: "MER-847 payment service P0 incident timeline. 14:15 UTC: deploy v2.4.1 pushed to production by CI pipeline. 14:23 UTC: PagerDuty alert fires — payment service p99 latency exceeds 3 second threshold. 14:25 UTC: Alex Kumar acknowledges alert. 14:30 UTC: Alex Kumar identifies PostgreSQL connection pool exhaustion as root cause. 14:35 UTC: Hotfix PR #1847 created — pool.max 20 to 50. 14:45 UTC: PR reviewed and approved by praveenk. 14:55 UTC: Hotfix deployed to production. 14:58 UTC: Payment service latency returns to normal, incident resolved. Total impact: 35 minutes downtime, 847 failed transactions. Post-mortem owner: Alex Kumar. Incident resolved and closed.",
  },
  {
    id: xid(24),
    connId: CONNS.snowflake, sourceType: "snowflake",
    title: "incident_log_2026 — MER-847 payment service incident data",
    externalId: "x-snow-incident-mer847",
    dept: DEPTS.engineering, visibility: "bi_accessible",
    url: "https://app.snowflake.com/meridian/incident_log_2026",
    createdAt: "2026-05-20T16:00:00Z",
    text: "Snowflake incident_log_2026 — MER-847 record. Incident type: P0 service outage. Service: payment-service. Start: 2026-05-20 14:23 UTC. End: 2026-05-20 14:58 UTC. Duration: 35 minutes. Root cause: PostgreSQL connection pool exhaustion (pool.max=20). Trigger: deploy v2.4.1 increased per-request DB queries from 2 to 5. Failed transactions: 847. Revenue impact: estimated $12,400 in failed checkouts. MTTR: 35 minutes. Incident commander: Alex Kumar. On-call team: backend-platform. Fix deployed: hotfix PR #1847, pool.max increased from 20 to 50. Post-mortem status: completed May 24 2026. Action items: 3 open, 0 completed as of May 28.",
  },

  // ─── DECISIONS THIS MONTH (5 docs) ─────────────────────────────────────────
  {
    id: xid(30),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Decision Log — May 2026 (all major decisions)",
    externalId: "x-gdrive-decision-log-may",
    dept: DEPTS.executive, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-decision-log-may26",
    createdAt: "2026-05-29T08:00:00Z",
    text: "Meridian Labs decision log for May 2026. Decision 1 (April 28, effective May 1): Move to usage-based pricing. $0.15/API call + $299/seat minimum. Decided by Sarah Chen, Marcus Reid, Priya Nair unanimously. Reason: 73% customer preference for usage-based, 30% lower CAC in pilot. Decision 2 (May 15): SmartSync launch date set to June 15 2026. Decided by Priya Nair with approval from Sarah Chen. 12 design partners committed. Decision 3 (May 20, reactive): Increase payment service connection pool from 20 to 50 following P0 incident MER-847. Decided by Alex Kumar under emergency authority. Decision 4 (May 22): Begin EMEA recovery plan — schedule executive calls for 3 stalled deals. Decided by Sarah Chen and Marcus Reid. Decision 5 (May 28): SOC 2 interim mitigation plan — provide pen test report to TechCorp UK by June 15 to unblock $280K deal. Decided by Jordan Lee and Sarah Chen.",
  },
  {
    id: xid(31),
    connId: CONNS.slack, sourceType: "slack",
    title: "#exec — decisions made this week (May 25–29)",
    externalId: "x-slack-decisions-week",
    dept: DEPTS.executive, visibility: "department",
    url: "https://meridian.slack.com/archives/C_EXEC/p1716976600",
    createdAt: "2026-05-29T07:00:00Z",
    text: "Weekly decisions summary May 25–29 2026. Decision 1: EMEA recovery plan approved — Sarah Chen and Marcus Reid approved executive rescue calls for TechCorp UK, Infratek DE, and Nordex FI this week. Decision 2: SOC 2 interim mitigation — Jordan Lee will deliver interim pen test report and security questionnaire to TechCorp UK by June 15 to unblock $280K deal while full SOC 2 certification continues on July 1 schedule. Decision 3: Auth-v2 review escalation — Alex Kumar escalated PR #1901 to all engineering leads as urgent, requesting immediate reviewers. Decision 4: SmartSync delay contingency — if auth-v2 does not merge by June 3, launch will be delayed one week to June 22. Decision 5: Board deck Series A ask confirmed — Sarah Chen approved including Series A process approval request in June 3 board agenda.",
  },
  {
    id: xid(32),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Decision: SmartSync launch date June 15 2026",
    externalId: "x-gdrive-smartsync-decision",
    dept: DEPTS.product, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-smartsync-launch-decision",
    createdAt: "2026-05-15T14:00:00Z",
    text: "Decision document: SmartSync launch date set to June 15 2026. Decided by: Priya Nair (VP Product), approved by Sarah Chen (CEO). Date of decision: May 15 2026. Rationale: core engine is complete, design partner feedback is positive (10 of 12 rate real-time sync as must-have), and engineering is confident in June 3 auth-v2 completion. Commitment: 12 enterprise design partners have been informed of the June 15 date. Contingency: if auth-v2 misses June 3, launch will be postponed to June 22. Risk acknowledged: any slip in auth-v2 directly impacts this date. Communications plan: blog post and design partner emails to go out June 1.",
  },
  {
    id: xid(33),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Decision: Hire 2 senior backend engineers Q2 2026",
    externalId: "x-gdrive-hiring-decision",
    dept: DEPTS.engineering, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-hiring-decision-q2",
    createdAt: "2026-04-30T16:00:00Z",
    text: "Decision: Approve 2 senior backend engineer hires for Q2 2026. Decided by: Alex Kumar (CTO), approved by Sarah Chen (CEO). Date: April 30 2026. Rationale: auth-v2 and SmartSync are both on the critical path and the engineering team is at capacity. Two additional senior engineers will unblock the review bottleneck and accelerate infrastructure roadmap. Budget approved: $240K annual salary per head, fully loaded $340K each. Target start: June 15. JDs posted May 2. Recruiter engaged. Profiles needed: strong Postgres, TypeScript, distributed systems background.",
  },
  {
    id: xid(34),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Decision: Snowflake as analytics data warehouse — February 2026",
    externalId: "x-gdrive-snowflake-decision",
    dept: DEPTS.engineering, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-snowflake-decision",
    createdAt: "2026-02-10T10:00:00Z",
    text: "Decision: Migrate analytics workloads from PostgreSQL OLAP to Snowflake. Decided by: Alex Kumar (CTO), Ravi Shankar (data platform lead). Date: February 10 2026. Rationale: PostgreSQL OLAP queries averaging 45 seconds are unacceptable for real-time dashboard use. Snowflake estimates 90%+ query time improvement with columnar storage and automatic clustering. Cost: Snowflake compute estimated $3,200/month at current query volume, compared to $1,800/month PostgreSQL overhead — acceptable for 94% performance gain. Timeline: 8-week migration, target completion March 14. Outcome: Completed March 12 2026 on schedule. Actual improvement: 94% (45.2s to 2.7s average query time). Decided to standardize all future analytics on Snowflake.",
  },

  // ─── NPS / CUSTOMER FEEDBACK (4 docs) ──────────────────────────────────────
  {
    id: xid(40),
    connId: CONNS.slack, sourceType: "slack",
    title: "#product — NPS 47 all-time high, what customers are saying",
    externalId: "x-slack-nps-detail",
    dept: DEPTS.product, visibility: "org_wide",
    url: "https://meridian.slack.com/archives/C_PROD/p1716800100",
    createdAt: "2026-05-27T15:00:00Z",
    text: "NPS hit 47 this month — all-time high. Here is what customers are actually saying. Top positive verbatims: 'Saves me 3 hours a week I used to spend in status meetings', 'Replaced 5 different status syncs', 'Finally know what my engineering team is working on without asking'. Top negative verbatims: 'Setup took 2 hours before I got my first useful answer', 'We need SSO — my IT team won't approve it without SAML', 'No mobile app is a problem for our field teams'. Key insight: the SSO issue came up 11 separate times this month across 3 enterprise accounts: TechCorp UK, Infratek DE, and Nexus Financial. Priya Nair is flagging SSO for Q3 roadmap prioritization.",
  },
  {
    id: xid(41),
    connId: CONNS.snowflake, sourceType: "snowflake",
    title: "customer_health_scores — enterprise account health",
    externalId: "x-snow-customer-health",
    dept: DEPTS.sales, visibility: "bi_accessible",
    url: "https://app.snowflake.com/meridian/customer_health_scores",
    createdAt: "2026-05-29T06:00:00Z",
    text: "Snowflake customer_health_scores — enterprise accounts as of May 28 2026. Accounts at risk of churn: Nexus Financial (health score 42/100 — low engagement, SSO not available, champion changed), Infratek DE (health score 51/100 — procurement freeze, low active users). Healthy enterprise accounts: Vantage Capital (score 89), BuildRight Inc (score 84), CloudNative Corp (score 81). Usage trend: DAU up 12% month-over-month across all accounts. Top feature by enterprise accounts: morning briefing used by 91% of enterprise seats. Feature most correlated with high health score: briefing + chat used together (r=0.73 with score). Feature most correlated with churn risk: zero chat queries in last 14 days.",
  },
  {
    id: xid(42),
    connId: CONNS.slack, sourceType: "slack",
    title: "#product — SSO is now blocking 3 enterprise deals, needs Q3 prioritization",
    externalId: "x-slack-sso-blocking",
    dept: DEPTS.product, visibility: "org_wide",
    url: "https://meridian.slack.com/archives/C_PROD/p1716890500",
    createdAt: "2026-05-28T12:00:00Z",
    text: "Priya Nair: SSO/SAML is now blocking enterprise sales and needs to be on the Q3 roadmap. Three separate accounts raised it in May: TechCorp UK says SSO is a procurement requirement, Infratek DE IT team requires it before approval, and new prospect Nexus Financial ($190K potential deal) says it is a deal-breaker. MER-920 is in backlog. Estimate: 3–4 weeks of backend work to implement SAML 2.0. Current Q2 roadmap is full: SmartSync, auth-v2, SOC2 tooling, performance work. Proposing SSO goes to June Q3 planning session as P1. Alex Kumar needs to weigh in on capacity. This is costing us real deals.",
  },
  {
    id: xid(43),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Q3 2026 Product Roadmap — Draft",
    externalId: "x-gdrive-q3-roadmap",
    dept: DEPTS.product, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-q3-roadmap-draft",
    createdAt: "2026-05-28T16:00:00Z",
    text: "Q3 2026 Product Roadmap — Draft as of May 28. Priority 1: SSO/SAML enterprise integration. Blocking 3 active deals ($615K combined), requested by TechCorp UK, Infratek DE, Nexus Financial. Owner: Alex Kumar (engineering lead), Priya Nair (product). Estimate: 3–4 weeks. Priority 2: Mobile app MVP — mentioned in 8 NPS detractor responses, field teams primary use case. Priority 3: SmartSync GA and upsell campaign — post June 15 launch, target $45K new MRR. Priority 4: Advanced briefing customization — ability to choose sections and sources per role. Priority 5: SOC 2 certification completion — audit window July 1–August 31, certification by end of Q3. Budget request: 2 additional headcount (backend for SSO, mobile for iOS app).",
  },

  // ─── FINANCIAL / ARR / REVENUE (4 docs) ────────────────────────────────────
  {
    id: xid(50),
    connId: CONNS.snowflake, sourceType: "snowflake",
    title: "arr_breakdown_may_2026 — ARR by segment and cohort",
    externalId: "x-snow-arr-breakdown",
    dept: DEPTS.executive, visibility: "bi_accessible",
    url: "https://app.snowflake.com/meridian/arr_breakdown_may_2026",
    createdAt: "2026-05-29T06:00:00Z",
    text: "Snowflake arr_breakdown_may_2026 as of May 29 2026. Total ARR: $4.2M. By segment: Enterprise (50+ seats) $2.1M (50%), Growth (16–49 seats) $1.47M (35%), SMB (1–15 seats) $630K (15%). Year-over-year growth by segment: Enterprise +31%, Growth +18%, SMB +4%. Top 10 customers represent 38% of ARR. New ARR in May: $47K. Churned ARR in May: $12K (2 SMB customers citing pricing change confusion). Net new ARR: $35K. SmartSync upsell pipeline: 8 existing customers on SmartSync waitlist representing $28K potential monthly expansion revenue. Series A target metrics: $6M ARR by Q4 2026 ($1.8M growth needed from current $4.2M), NRR above 110%, CAC payback under 10 months.",
  },
  {
    id: xid(51),
    connId: CONNS.slack, sourceType: "slack",
    title: "#exec — Series A readiness metrics and what we need",
    externalId: "x-slack-series-a",
    dept: DEPTS.executive, visibility: "department",
    url: "https://meridian.slack.com/archives/C_EXEC/p1716303600",
    createdAt: "2026-05-21T09:00:00Z",
    text: "Sarah Chen: Series A target metrics and current status. We need $6M ARR to raise at a strong multiple — currently at $4.2M, need $1.8M more growth. NRR needs to be above 110% — currently 108.3%, close. CAC payback under 10 months — currently 11 months, improving. Timeline: begin process Q4 2026. Key growth levers before raising: SmartSync launches June 15 (projected $45K new MRR by end of Q3), EMEA recovery ($520K at risk must be converted), enterprise segment expansion (SSO unlocks Nexus Financial and Infratek DE). Board will discuss Series A readiness at June 3 meeting. If SmartSync performs as projected and EMEA recovers, we hit $5.5M ARR by end of Q3 — strong enough to start the process.",
  },
  {
    id: xid(52),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Financial Summary — Q2 May 2026 Burn and Runway",
    externalId: "x-gdrive-financials-q2",
    dept: DEPTS.executive, visibility: "department",
    url: "https://drive.google.com/file/d/meridian-financials-q2-may",
    createdAt: "2026-05-28T09:00:00Z",
    text: "Meridian Labs financial summary Q2 May 2026. Monthly recurring revenue: $350K. Annual recurring revenue: $4.2M. Burn rate: $380K per month. Runway: 14 months at current burn. Cash in bank: $5.32M. Burn multiple: 2.1x (net new ARR $35K divided by net burn $73K after revenue). Largest expense categories: salaries and benefits 71% ($270K/mo), cloud infrastructure 12% ($45K/mo), sales and marketing 11% ($42K/mo), other 6%. Revenue growth trajectory: 6.2% month-over-month for last 3 months. ARR milestones: $3M June 2025, $4M February 2026, $4.2M May 2026. Capital efficiency improving with usage-based pricing — customers with high usage expanding faster than projected.",
  },
  {
    id: xid(53),
    connId: CONNS.snowflake, sourceType: "snowflake",
    title: "sales_performance_q2 — win rates, cycle length, pipeline velocity",
    externalId: "x-snow-sales-perf",
    dept: DEPTS.sales, visibility: "bi_accessible",
    url: "https://app.snowflake.com/meridian/sales_performance_q2",
    createdAt: "2026-05-29T06:00:00Z",
    text: "Snowflake sales_performance_q2 as of May 27 2026. Global win rate: 31%. EMEA win rate: 22% (below global average by 9 points). Average sales cycle: 47 days global, 67 days EMEA. Pipeline velocity: $3.8K per day global, $1.1K per day EMEA. Deals in negotiation stage over 30 days: 4 deals (TechCorp UK 47 days, Infratek DE 38 days, two other EMEA deals). CAC by segment: enterprise $18,200, growth $6,400, SMB $1,800. CAC payback: enterprise 11 months, growth 8 months, SMB 4 months. Closed won in May: 8 deals, $91K new ARR. Closed lost in May: 3 deals, $64K — reasons: pricing change confusion (2), competitor (1). Top performing rep: Marcus Reid ($180K pipeline managed).",
  },

  // ─── SOC 2 AND COMPLIANCE (4 docs) ─────────────────────────────────────────
  {
    id: xid(60),
    connId: CONNS.slack, sourceType: "slack",
    title: "#operations — SOC 2 status update and what is still needed",
    externalId: "x-slack-soc2-status",
    dept: DEPTS.operations, visibility: "org_wide",
    url: "https://meridian.slack.com/archives/C_OPS/p1716562900",
    createdAt: "2026-05-24T10:00:00Z",
    text: "SOC 2 Type II status update May 24 — Jordan Lee. Current state: Vanta compliance platform deployed, 67% of controls green. Auditor Schellman and Company engaged, audit window July 1 through August 31 2026. Remaining gaps that must be remediated before audit: 1) Access review policy — needs formal documentation and quarterly review process (owner: Jordan Lee, due June 15). 2) Vendor risk assessment — 23 critical vendors not yet assessed (owner: Jordan Lee, due June 30). 3) Incident response plan — draft exists, needs board approval (owner: Alex Kumar, due June 10). Why this matters: TechCorp UK ($280K deal) is explicitly blocked on SOC 2. Also required by Infratek DE and Nexus Financial. Certification target: end of Q3 2026.",
  },
  {
    id: xid(61),
    connId: CONNS.jira, sourceType: "jira",
    title: "MER-750: SOC 2 gaps — access review, vendor risk, incident response",
    externalId: "x-jira-MER-750-gaps",
    dept: DEPTS.operations, visibility: "org_wide",
    url: "https://meridian.atlassian.net/browse/MER-750",
    createdAt: "2026-05-15T10:00:00Z",
    text: "MER-750 SOC 2 Type II — open gaps requiring remediation. Gap 1: Access review policy. Currently: no formal quarterly access review process. Required: documented policy with quarterly cadence and approval workflow. Owner: Jordan Lee. Due: June 15 2026. Gap 2: Vendor risk assessment. Currently: 23 critical third-party vendors not assessed for SOC 2 compliance. Required: vendor risk questionnaire completed and documented for all critical vendors. Owner: Jordan Lee. Due: June 30 2026. Gap 3: Incident response plan. Currently: informal process, post-mortem template exists. Required: formal IRP document with roles, escalation matrix, and communication templates. Owner: Alex Kumar. Due: June 10 2026. All three gaps must be resolved before audit window opens July 1. Certification target: September 2026.",
  },
  {
    id: xid(62),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "SOC 2 Interim Mitigation — Security package for TechCorp UK",
    externalId: "x-gdrive-soc2-interim",
    dept: DEPTS.operations, visibility: "department",
    url: "https://drive.google.com/file/d/meridian-soc2-interim-techcorp",
    createdAt: "2026-05-28T15:00:00Z",
    text: "SOC 2 interim mitigation plan for TechCorp UK. While full SOC 2 Type II certification is in progress (audit July 1–August 31), TechCorp UK procurement requires some security assurance to unblock the $280K deal. Interim security package to be delivered by June 15: 1) Completed security questionnaire covering all controls in Vanta (Jordan Lee, due June 10). 2) Independent pen test report from CrowdStrike engagement (scheduled June 3, report due June 12). 3) Architecture overview showing data isolation, encryption at rest and in transit, access controls. 4) Reference letter from existing enterprise customers on security practices. Jordan Lee is responsible for compiling and delivering this package. Sarah Chen will present it to TechCorp UK CTO on the executive call.",
  },
  {
    id: xid(63),
    connId: CONNS.slack, sourceType: "slack",
    title: "#operations — Jordan Lee owns SOC 2, these are the blockers",
    externalId: "x-slack-jordan-soc2",
    dept: DEPTS.operations, visibility: "org_wide",
    url: "https://meridian.slack.com/archives/C_OPS/p1716726000",
    createdAt: "2026-05-26T09:00:00Z",
    text: "Jordan Lee here — SOC 2 owner update. I am responsible for SOC 2 Type II certification at Meridian Labs (MER-750). Current blockers on my side: vendor risk assessment for 23 vendors is taking longer than expected — need engineering team to provide technical questionnaire responses for 8 infrastructure vendors by June 7. Alex Kumar to assign someone. Access review policy doc is drafted and going to Sarah Chen for approval next week. The TechCorp UK interim security package is my priority this week — pen test scheduled June 3, security questionnaire 90% complete. The SOC 2 certification directly unblocks: TechCorp UK ($280K), Infratek DE ($145K consideration), Nexus Financial ($190K prospect). That is $615K in deals depending on this work.",
  },

  // ─── TEAM MEMBERS AND RESPONSIBILITIES (4 docs) ────────────────────────────
  {
    id: xid(70),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Meridian Labs — Org Chart and Team Responsibilities May 2026",
    externalId: "x-gdrive-org-chart",
    dept: null, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-org-chart-may26",
    createdAt: "2026-05-01T09:00:00Z",
    text: "Meridian Labs org chart and responsibilities May 2026. Sarah Chen — CEO. Owns: company strategy, board relationships, Series A process, executive customer relationships. Direct reports: Alex Kumar, Priya Nair, Marcus Reid, Jordan Lee. Alex Kumar — CTO. Owns: engineering roadmap, auth-v2, post-mortem action items, Q2 hiring, incident response. Team: backend-platform (Dmitri Volkov), frontend (Kai Mueller), data-platform (Ravi Shankar). Priya Nair — VP Product. Owns: SmartSync epic, product roadmap, NPS program, design partner relationships. Marcus Reid — VP Sales. Owns: global pipeline, EMEA recovery plan, TechCorp UK account, usage-based pricing rollout. Jordan Lee — Head of Operations. Owns: SOC 2 Type II certification, vendor risk, access review policy, compliance documentation.",
  },
  {
    id: xid(71),
    connId: CONNS.slack, sourceType: "slack",
    title: "#general — who owns what in engineering right now",
    externalId: "x-slack-eng-owners",
    dept: DEPTS.engineering, visibility: "org_wide",
    url: "https://meridian.slack.com/archives/C_GENERAL/p1716717600",
    createdAt: "2026-05-25T16:00:00Z",
    text: "Engineering ownership as of May 25 2026. Alex Kumar (CTO): auth-v2 CI fix, Datadog monitoring, post-mortem action items, hiring two senior engineers. Dmitri Volkov: auth-v2 PR #1901 (author), overall auth service. Kai Mueller: invoice EUR formatting bug MER-889, frontend components, SmartSync UI. Ravi Shankar: Snowflake pipelines, dbt models, data platform. Praveenk: backend platform, SmartSync core engine review. Eleanor Chan: backend platform, auth-v2 reviewer. The two most urgent engineering items right now: 1) auth-v2 PR #1901 review (blocking SmartSync launch) — needs Alex Kumar to fix Vault CI, then praveenk and eleanor-chan to review. 2) Invoice bug MER-889 — Kai Mueller, ETA June 2.",
  },
  {
    id: xid(72),
    connId: CONNS.gdrive, sourceType: "gdrive",
    title: "Weekly Engineering Update — May 25–29 2026",
    externalId: "x-gdrive-eng-update-may29",
    dept: DEPTS.engineering, visibility: "org_wide",
    url: "https://drive.google.com/file/d/meridian-eng-update-may29",
    createdAt: "2026-05-29T07:00:00Z",
    text: "Engineering weekly update May 25–29 2026. Completed: SmartSync core engine fully merged (PR #1876), p99 340ms in staging. SmartSync UI 80% complete, frontend team finishing by May 31. In progress: Auth-v2 PR #1901 — Dmitri Volkov author, Alex Kumar fixing CI (Vault token), reviewers urgently needed. Invoice bug MER-889 — Kai Mueller, code in review, ETA June 2. SOC2 incident response plan — Alex Kumar, due June 10. Starting next week: QA environment configuration (June 1), SmartSync documentation (June 2), connection pool audit across all services (Dmitri Volkov). Blockers: Vault token in GitHub Actions CI for auth-service repo (action: Alex Kumar today). Hiring: 2 backend engineer candidates in final round interviews.",
  },
  {
    id: xid(73),
    connId: CONNS.slack, sourceType: "slack",
    title: "#sales — Marcus Reid is EMEA account owner, here is the recovery plan",
    externalId: "x-slack-emea-recovery-owner",
    dept: DEPTS.sales, visibility: "department",
    url: "https://meridian.slack.com/archives/C_SALES/p1716717700",
    createdAt: "2026-05-25T17:00:00Z",
    text: "Marcus Reid — EMEA pipeline recovery update. I own all three at-risk EMEA deals. TechCorp UK $280K: Sarah Chen is calling their CTO this week. I am coordinating Jordan Lee to deliver the SOC2 security questionnaire by June 10. Invoice bug fix coming June 2 from Kai Mueller. Infratek DE $145K: I scheduled an exec call for June 2 between Sarah Chen and Infratek CTO. Offering custom contract with 60-day delayed billing start to work around their procurement freeze. Nordex FI $95K: I am using LinkedIn Sales Navigator to identify the new champion — found two candidates, reaching out this week. Offering SmartSync closed beta access as hook. Target: at least 2 of 3 deals back in active negotiation by June 15. Total exposure: $520K. This is my top priority.",
  },
];

async function embedWithJina(texts: string[]): Promise<number[][]> {
  if (!JINA_API_KEY) throw new Error("JINA_API_KEY not set");
  const BATCH = 20;
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch("https://api.jina.ai/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${JINA_API_KEY}` },
      body: JSON.stringify({ model: "jina-embeddings-v3", input: batch, dimensions: 768 }),
    });
    if (!res.ok) throw new Error(`Jina failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    all.push(...json.data.map((d) => d.embedding));
    console.log(`  Embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}…`);
  }
  return all;
}

async function main() {
  console.log("\n🚀 Athene Demo Seed (Extended) — Meridian Labs\n");

  const { data: m } = await db.from("org_members").select("id, org_id").eq("clerk_user_id", REAL_CLERK_USER_ID).limit(1).single();
  if (!m) { console.error("❌  No org found for clerk_user_id"); process.exit(1); }
  const { org_id: orgId, id: memberId } = m;
  console.log(`Org: ${orgId}\nMember: ${memberId}\n`);

  console.log(`Inserting ${EXTENDED_DOCS.length} document metadata rows…`);
  for (const doc of EXTENDED_DOCS) {
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
      external_url: doc.url,
      chunk_count: 1,
      last_indexed_at: doc.createdAt,
      metadata: {},
    }, { onConflict: "id" }).throwOnError();
  }

  console.log(`\nGenerating ${EXTENDED_DOCS.length} embeddings via Jina AI…`);
  const embeddings = await embedWithJina(EXTENDED_DOCS.map((d) => d.text));

  console.log(`\nInserting ${EXTENDED_DOCS.length} document_embeddings…`);
  const rows = EXTENDED_DOCS.map((doc, i) => ({
    org_id: orgId,
    document_id: doc.id,
    chunk_index: 0,
    content_preview: doc.text.slice(0, 200),
    embedding: `[${embeddings[i].join(",")}]`,
    department_id: doc.dept,
    owner_user_id: memberId,
    visibility: doc.visibility,
    source_type: doc.sourceType,
    token_count: Math.ceil(doc.text.length / 4),
    metadata: { title: doc.title, external_url: doc.url },
  }));

  await db.from("document_embeddings").upsert(rows, { onConflict: "document_id,chunk_index" }).throwOnError();

  console.log(`\n✅ Extended seed complete! ${EXTENDED_DOCS.length} additional documents added.\n`);
  console.log("Coverage added:");
  console.log("  • 7 docs specifically about TechCorp UK deal blockers");
  console.log("  • 6 docs about SmartSync launch blockers and ownership");
  console.log("  • 5 docs about MER-847 payment incident");
  console.log("  • 5 docs about decisions made in May 2026");
  console.log("  • 4 docs about NPS and customer feedback");
  console.log("  • 4 docs about financial/ARR/Series A");
  console.log("  • 4 docs about SOC 2 and compliance");
  console.log("  • 4 docs about team members and who owns what");
}

main();
