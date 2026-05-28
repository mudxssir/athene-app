// ============================================================
// lib/telemetry/metrics.ts — Athene metrics instruments
//
// Defines all application-level metric counters and histograms.
// Metrics are no-ops when OpenTelemetry is not initialized
// (OTEL_EXPORTER_OTLP_ENDPOINT not set) — safe to call anywhere.
// ============================================================

import { metrics, type Counter, type Histogram } from "@opentelemetry/api";

const METER_NAME = "athene-app";
const METER_VERSION = "1.0.0";

function getMeter() {
  return metrics.getMeter(METER_NAME, METER_VERSION);
}

// Lazy singletons — created on first use (after SDK initialisation), then cached.
// Calling getMeter().createHistogram() on every record() invocation is valid but
// allocates a new wrapper each time and triggers duplicate-name warnings in strict mode.
let _agentRunDuration: Histogram | undefined;
let _agentRunError: Counter | undefined;
let _hitlApprovalDuration: Histogram | undefined;
let _hitlDecision: Counter | undefined;
let _indexedDocCount: Counter | undefined;
let _indexingDuration: Histogram | undefined;
let _integrationFetchDuration: Histogram | undefined;

// ─── Agent Run Metrics ────────────────────────────────────────

/**
 * Records agent run duration in milliseconds.
 * Labels: model (string), org_id (string)
 */
export function recordAgentRunDuration(ms: number, labels: { model: string; orgId: string }): void {
  (_agentRunDuration ??= getMeter().createHistogram("athene_agent_run_duration_ms", {
    description: "Agent run duration in milliseconds",
    unit: "ms",
  })).record(ms, { model: labels.model, org_id: labels.orgId });
}

/**
 * Increments the agent run error counter.
 * Labels: error_type (string), node_name (string)
 */
export function incrementAgentRunError(labels: { errorType: string; nodeName: string }): void {
  (_agentRunError ??= getMeter().createCounter("athene_agent_run_error_total", {
    description: "Number of agent run errors by type and node",
  })).add(1, { error_type: labels.errorType, node_name: labels.nodeName });
}

// ─── HITL Metrics ────────────────────────────────────────────

/**
 * Records how long a HITL action waited for human approval.
 * Labels: tool (string, e.g. "email-send" | "calendar-create")
 */
export function recordHitlApprovalDuration(ms: number, labels: { tool: string }): void {
  (_hitlApprovalDuration ??= getMeter().createHistogram("athene_hitl_approval_pending_duration_ms", {
    description: "Time from HITL action creation to human decision in milliseconds",
    unit: "ms",
  })).record(ms, { tool: labels.tool });
}

/**
 * Increments the HITL decision counter.
 * Labels: decision ("approve" | "edit" | "reject"), tool (string)
 */
export function incrementHitlDecision(labels: { decision: string; tool: string }): void {
  (_hitlDecision ??= getMeter().createCounter("athene_hitl_decision_total", {
    description: "Number of HITL decisions by outcome and tool",
  })).add(1, { decision: labels.decision, tool: labels.tool });
}

// ─── Indexer Metrics ─────────────────────────────────────────

/**
 * Increments the document indexing counter. Call only on full pipeline success.
 * Labels: integration_type (string), org_id (string)
 */
export function incrementIndexedDocCount(labels: { integrationType: string; orgId: string }): void {
  (_indexedDocCount ??= getMeter().createCounter("athene_indexer_doc_count_total", {
    description: "Number of documents successfully indexed by integration type",
  })).add(1, { integration_type: labels.integrationType, org_id: labels.orgId });
}

/**
 * Records indexing pipeline duration in milliseconds.
 * Labels: integration_type (string)
 */
export function recordIndexingDuration(ms: number, labels: { integrationType: string }): void {
  (_indexingDuration ??= getMeter().createHistogram("athene_indexer_duration_ms", {
    description: "Document indexing pipeline duration in milliseconds",
    unit: "ms",
  })).record(ms, { integration_type: labels.integrationType });
}

// ─── Integration Fetch Metrics ────────────────────────────────

/**
 * Records integration provider fetch duration in milliseconds.
 * Labels: provider (string, e.g. "github" | "linear" | "powerbi")
 */
export function recordIntegrationFetchDuration(ms: number, labels: { provider: string }): void {
  (_integrationFetchDuration ??= getMeter().createHistogram("athene_integration_fetch_duration_ms", {
    description: "Integration provider fetch duration in milliseconds",
    unit: "ms",
  })).record(ms, { provider: labels.provider });
}

