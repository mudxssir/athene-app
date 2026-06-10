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
