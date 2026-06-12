// ============================================================
// lib/config/feature-flags.ts — REFOCUS freeze flags (§3)
//
// The product narrowed to a read-only org-memory engine. Frozen
// surfaces are flag-gated — not deleted — so re-enabling is a
// config change, not a code restore.
// ============================================================

/**
 * Write-action agents (email send/draft, calendar create, action
 * executor, conversational integration connect/disconnect/re-sync)
 * and the automation builder UI (REFOCUS §3.1 / §3.2).
 * Default OFF. Set WRITE_ACTIONS_ENABLED=true to unfreeze.
 */
export const WRITE_ACTIONS_ENABLED = process.env.WRITE_ACTIONS_ENABLED === "true";

/**
 * P1: Shape-based routing replaces five provider-string Sets in the indexing
 * pipeline (fixes audit D1/D3/D9/D10). Default OFF — legacy provider-string
 * routing remains active until the flag is flipped per-org on pilot.
 * Set PIPELINE_SHAPE_ROUTING=true to activate.
 */
export const PIPELINE_SHAPE_ROUTING = process.env.PIPELINE_SHAPE_ROUTING === "true";

/**
 * P2: deterministic PERSON nodes + ownership edges (OWNS/WORKS_ON/REPORTED_BY)
 * built from fetcher-emitted structured_owners in the KG builder. Default OFF
 * until the P2 gate (rollback story: owner-graph step behind flag).
 * Set KG_OWNER_GRAPH=true to activate.
 */
export const KG_OWNER_GRAPH = process.env.KG_OWNER_GRAPH === "true";
