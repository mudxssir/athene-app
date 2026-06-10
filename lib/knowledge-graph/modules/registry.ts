// ============================================================
// lib/knowledge-graph/modules/registry.ts
//
// Vertical knowledge modules. Each module adds domain-specific
// entity types, relation types, and extraction prompt addenda
// that are injected into the KG extractor when the org has
// connected the activating integration source(s).
//
// Activation is automatic — no admin configuration required.
// ============================================================

export interface VerticalModule {
  id: string;
  name: string;
  /** source_type values from the connections table that activate this module */
  activating_sources: string[];
  entity_types: string[];
  relation_types: string[];
  /** Appended to the base EXTRACTION_PROMPT when this module is active */
  extraction_prompt_addendum: string;
  /** Injected into the synthesis prompt when this department's chunks dominate retrieved context */
  synthesis_prompt_addendum: string;
}

export const VERTICAL_MODULES: VerticalModule[] = [
  // ── Revenue Operations ─────────────────────────────────────
  {
    id: "revops",
    name: "Revenue Operations",
    activating_sources: ["salesforce", "hubspot"],
    entity_types: [
      "deal",
      "account",
      "contact",
      "persona",
      "objection",
      "win_reason",
      "loss_reason",
      "competitor",
    ],
    relation_types: [
      "COMPETES_WITH",
      "OBJECTED_TO",
      "WON_AGAINST",
      "LOST_TO",
      "EXPANDED_FROM",
      "CHURNED_FROM",
      "INFLUENCED_BY",
    ],
    synthesis_prompt_addendum: "Focus on pipeline metrics, ARR impact, conversion rates, and revenue forecasting. Quantify business impact in $ terms where data allows. Surface win/loss patterns and competitive intelligence.",
    extraction_prompt_addendum: `
## Revenue Operations domain extensions

Additional entity types (use these when reading CRM or sales content):

- \`deal\` — A named sales opportunity, proposal, or commercial contract
- \`account\` — A company being sold to, managed, or tracked as a customer
- \`contact\` — A named individual at an account (buyer, champion, blocker)
- \`persona\` — A buying role or job function (e.g. "CFO buyer", "technical champion")
- \`objection\` — A stated reason a prospect gave for not buying or delaying
- \`win_reason\` — A stated reason why a deal was closed successfully
- \`loss_reason\` — A stated reason why a deal was lost or churned
- \`competitor\` — A competing vendor or product mentioned in a deal context

Additional relation types:

- \`COMPETES_WITH\` — product or account competes against a competitor
- \`OBJECTED_TO\` — contact raised an objection during a deal
- \`WON_AGAINST\` — deal was won in a competitive evaluation against a competitor
- \`LOST_TO\` — deal was lost to a specific competitor
- \`EXPANDED_FROM\` — account expanded from an existing contract
- \`CHURNED_FROM\` — account churned from a prior contract
- \`INFLUENCED_BY\` — deal outcome was influenced by a person, event, or factor`,
  },

  // ── Engineering Intelligence ───────────────────────────────
  {
    id: "engineering",
    name: "Engineering Intelligence",
    activating_sources: ["github", "linear", "jira"],
    entity_types: [
      "incident",
      "runbook",
      "pull_request",
      "tech_debt_item",
      "sla_item",
      "on_call_rotation",
      "architecture_decision",
    ],
    relation_types: [
      "CAUSED_INCIDENT",
      "RESOLVED_BY",
      "BLOCKS",
      "BLOCKED_BY",
      "DEPLOYED_WITH",
      "DEPRECATED_BY",
      "ONCALL_FOR",
    ],
    synthesis_prompt_addendum: "Focus on incident severity (P0/P1/P2), MTTR, deployment frequency, and blast radius. Link technical decisions to business outcomes. Surface on-call patterns and recurring failure modes.",
    extraction_prompt_addendum: `
## Engineering Intelligence domain extensions

Additional entity types (use these when reading GitHub, Jira, Linear, or PagerDuty content):

- \`incident\` — A production issue, outage, on-call page, or failure event
- \`runbook\` — A documented response or operational procedure
- \`pull_request\` — A code change submitted for review (use PR title as label)
- \`tech_debt_item\` — An identified technical liability or deferred improvement
- \`sla_item\` — A defined service level agreement or reliability target
- \`on_call_rotation\` — A named on-call schedule or rotation assignment
- \`architecture_decision\` — A choice about system design or technical approach

Additional relation types:

- \`CAUSED_INCIDENT\` — a service, change, or deploy caused an incident
- \`RESOLVED_BY\` — an incident or issue was resolved by a person or runbook
- \`BLOCKS\` — a ticket, PR, or task prevents another entity from progressing
- \`BLOCKED_BY\` — a ticket, project, or task is blocked by another entity
- \`DEPLOYED_WITH\` — a change or feature was deployed alongside another
- \`DEPRECATED_BY\` — a service or API was replaced by another
- \`ONCALL_FOR\` — a person or team is on-call for a service

Blocking extraction rules for engineering sources:
- Explicit issue links ("blocked by PROJ-123", Jira/Linear "blocks" links, "depends on #456"): \`EXTRACTED\`, confidence 1.0.
- Textual waiting language ("waiting on the API team", "can't merge until X lands"): \`INFERRED\`, confidence 0.6–0.9.`,
  },

  // ── Customer Success ───────────────────────────────────────
  {
    id: "customer_success",
    name: "Customer Success",
    activating_sources: ["zendesk", "intercom", "salesforce"],
    entity_types: [
      "customer",
      "feature_request",
      "bug_report",
      "renewal",
      "health_score",
      "success_plan",
    ],
    relation_types: [
      "REPORTED_BY",
      "AFFECTS",
      "REQUESTED_BY",
      "RESOLVED_VIA",
      "IMPACTS_RENEWAL",
      "TIED_TO_ACCOUNT",
    ],
    synthesis_prompt_addendum: "Focus on CSAT scores, ticket resolution times, churn risk signals, and account health. Surface early warning indicators. Distinguish between one-off issues and systemic patterns affecting multiple accounts.",
    extraction_prompt_addendum: `
## Customer Success domain extensions

Additional entity types (use these when reading Zendesk, Intercom, or CS content):

- \`customer\` — A named customer or end user (distinct from an account/company)
- \`feature_request\` — A capability explicitly requested by a customer
- \`bug_report\` — A defect or unexpected behaviour reported by a customer
- \`renewal\` — A contract renewal event, risk, or milestone
- \`health_score\` — A named customer health or churn-risk metric
- \`success_plan\` — A documented customer success or onboarding plan

Additional relation types:

- \`REPORTED_BY\` — a bug or request was reported by a specific customer
- \`AFFECTS\` — an issue or incident affects a customer or account
- \`REQUESTED_BY\` — a feature or change was requested by a specific customer
- \`RESOLVED_VIA\` — a ticket or complaint was resolved via a workaround or fix
- \`IMPACTS_RENEWAL\` — an issue or request has bearing on a renewal decision
- \`TIED_TO_ACCOUNT\` — a contact, ticket, or plan is associated with an account`,
  },

  // ── Legal & Compliance ─────────────────────────────────────
  {
    id: "legal_compliance",
    name: "Legal & Compliance",
    activating_sources: ["google_drive", "sharepoint", "notion"],
    entity_types: [
      "contract",
      "clause",
      "counterparty",
      "regulation",
      "risk_item",
      "audit_finding",
    ],
    relation_types: [
      "OBLIGATES",
      "RESTRICTS",
      "SUBJECT_TO",
      "GOVERNS",
      "BREACHES",
      "RISKS",
    ],
    synthesis_prompt_addendum: "Focus on SLA obligations, compliance gaps, policy effective dates, and risk exposure level (HIGH/MEDIUM/LOW). Always cite the source document title and section number. Flag any time-sensitive obligations or upcoming deadlines explicitly.",
    extraction_prompt_addendum: `
## Legal & Compliance domain extensions

Additional entity types (use these when reading contracts, policies, or compliance documents):

- \`contract\` — A named binding agreement or executed document
- \`clause\` — A specific provision or section within a contract
- \`counterparty\` — An external party to a contract or agreement
- \`regulation\` — An external regulatory requirement, law, or standard (e.g. GDPR, SOC2)
- \`risk_item\` — An identified legal, financial, or operational risk
- \`audit_finding\` — A finding from an internal or external audit

Additional relation types:

- \`OBLIGATES\` — a contract or clause creates an obligation for a party
- \`RESTRICTS\` — a clause or regulation restricts an activity or entity
- \`SUBJECT_TO\` — an entity is subject to a regulation or requirement
- \`GOVERNS\` — a contract or policy governs a relationship or activity
- \`BREACHES\` — an action or event breaches a contract or regulation
- \`RISKS\` — a risk item threatens a project, process, or obligation`,
  },
];
