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

/**
 * P3: promote binary parsing to the tiered cascade — sidecar `/parse` (Docling)
 * lane 1 → LlamaParse lane 2 (per-org opt-in via `organizations.external_
 * parsing_allowed`) → in-process TS parsers lane 3. Default OFF: when off, the
 * connectors keep their current LlamaParse-or-TS behavior unchanged. When on,
 * the sidecar is tried first (and its richer Docling output — heading tree,
 * tables, picture refs — feeds the structural/tabular/media adapters).
 * Rollback story: flag off → P1 inline-parser behavior. Set SIDECAR_PARSING=true.
 */
export const SIDECAR_PARSING = process.env.SIDECAR_PARSING === "true";

/**
 * P3: the context envelope — every chunk is embedded as
 * `contextHeader + '\n\n' + chunkText`, where the header layers a deterministic
 * breadcrumb, a cached per-document context line, and (for prose/email/work_item)
 * a per-chunk situating line. The raw chunk_text stored for KG/citations is never
 * changed; the header lives in a separate embedding-row metadata key. Default OFF
 * until the P3 gate (rollback: off → breadcrumb-only, never blocks indexing).
 * Set CONTEXT_ENVELOPE=true to activate.
 */
export const CONTEXT_ENVELOPE = process.env.CONTEXT_ENVELOPE === "true";

/**
 * P4: deterministic Tier-C knowledge-graph path for tabular documents (audit D2).
 * When ON, the builder runs `extractSchemaEntities` (table → service node, columns →
 * metric/dimension concept nodes, all EXTRACTED/1.0, ZERO LLM calls) for tabular
 * docs and skips the LLM extractor for them entirely — instead of the current
 * behavior where BI stats chunks either get skipped (no graph) or run LLM over
 * statistical text. Default OFF until the P4 gate (rollback: off → current
 * LLM-on-everything / skip behavior). Set TABULAR_TIER_C=true to activate.
 */
export const TABULAR_TIER_C = process.env.TABULAR_TIER_C === "true";

/**
 * P4-3: mask PII (email / SSN / phone) in tabular SAMPLE chunk values before they
 * are embedded. Statistical aggregates (counts, ranges, distinct) are unaffected;
 * only rendered raw cell values are masked. Default OFF: masking changes embedded
 * content, so it is opt-in per the flags-default-off discipline (an org that wants
 * it sets TABULAR_PII_MASKING=true). Rollback: off → raw values (re-index reverts).
 */
export const TABULAR_PII_MASKING = process.env.TABULAR_PII_MASKING === "true";

/**
 * P4-7: deterministic CRM field edges in the KG builder. From CRM record chunks
 * (Salesforce/HubSpot) that carry `structured_owners` (owner → OWNS) and
 * `structured_account` (record → TIED_TO_ACCOUNT account node), build those
 * edges with ZERO LLM (EXTRACTED/1.0), mirroring the P2 structured-owner graph.
 * Default OFF until the P4 gate (rollback: off → no CRM field edges; LLM
 * extraction over record text still runs per the Tier-B gate). Set
 * KG_CRM_EDGES=true to activate.
 */
export const KG_CRM_EDGES = process.env.KG_CRM_EDGES === "true";
