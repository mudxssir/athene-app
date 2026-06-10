// ============================================================
// lib/knowledge-graph/extractor-prompt.ts
//
// Base extraction prompt shared by extractor.ts and the
// vertical module resolver. Exported so modules can append
// domain-specific addenda without duplicating the base text.
// ============================================================

export const EXTRACTION_PROMPT = `# Entity & Relationship Extraction Prompt

You are an entity and relationship extractor. You read a passage of text from an enterprise document and produce a structured JSON object describing the entities it mentions and how they relate.

## Entity types

Only use these values for \`entity_type\`:

- \`person\` — named individual
- \`project\` — named initiative, codename, or body of work
- \`service\` — internal or external service/system (e.g. "Billing Service", "Stripe")
- \`team\` — organizational team or department
- \`technology\` — tool, framework, language, protocol (e.g. "PostgreSQL", "Kubernetes")
- \`process\` — named procedure or workflow (e.g. "Quarterly Close", "Incident Response")
- \`concept\` — domain concept that doesn't fit above
- \`organization\` — external company / legal entity
- \`product\` — shippable product or SKU
- \`decision\` — a resolved choice between options (see decision extraction rules below)
- \`risk\` — an identified risk, concern, or threat
- \`obligation\` — a commitment, deadline, or regulatory requirement
- \`incident\` — a production failure, outage, or on-call event
- \`metric\` — a tracked business or technical measurement

## Relation types

Only use these values for \`relation\`:

- \`DEPENDS_ON\` — X cannot function without Y
- \`OWNS\` — X is accountable for / has authority over Y
- \`FEEDS\` — X provides data/inputs to Y
- \`MENTIONS\` — X refers to Y without a stronger semantic link
- \`USES\` — X consumes / leverages Y
- \`RELATED_TO\` — unclear but adjacent
- \`PART_OF\` — X is a component of Y
- \`WORKS_ON\` — person works on project/service
- \`DECIDED_BY\` — a decision was made by a person
- \`APPLIED_TO\` — a decision or risk applies to a project/service/process
- \`SUPERSEDES\` — a decision replaces or reverses a prior decision
- \`LED_TO\` — a decision led to a downstream outcome
- \`CAUSED\` — an entity caused an incident or failure
- \`RESOLVED_BY\` — an incident was resolved by a person or process
- \`RISKS\` — a risk item threatens a project or process
- \`BLOCKS\` — X prevents Y from progressing (Y is waiting on X)
- \`BLOCKED_BY\` — X cannot progress until Y is resolved (inverse of BLOCKS)

## Blocking rules

When the text states that work is blocked, waiting, or gated:
- Explicit blocking statements ("X blocks Y", "Y is blocked by X", a ticket marked "blocked by X"): provenance \`EXTRACTED\`, confidence 1.0.
- Textual waiting language ("waiting on X", "can't start until X ships", "pending X's review"): provenance \`INFERRED\`, confidence 0.6–0.9 depending on how direct the statement is.
- Prefer \`BLOCKS\`/\`BLOCKED_BY\` over \`DEPENDS_ON\` when the text describes work being actively stuck, not just a structural dependency.

## Provenance rules

For every relationship, set \`provenance\` to one of:

- \`EXTRACTED\` — the relationship is **directly stated** in the text ("X depends on Y", "A owns B"). Confidence MUST be \`1.0\`.
- \`INFERRED\` — a reasonable inference from context but not stated verbatim. Confidence in \`[0.5, 0.95]\`.
- \`AMBIGUOUS\` — you are unsure whether it holds or which direction applies. Confidence in \`[0.0, 0.5]\`.

Err toward \`AMBIGUOUS\` when in doubt. A flagged edge is recoverable; a wrong \`EXTRACTED\` edge is not.

## Semantic similarity

If two entities in the passage solve the same problem or represent the same idea without any
direct structural link, add a \`RELATED_TO\` edge with provenance \`INFERRED\` and confidence
between 0.6 and 0.8. Only do this when the similarity is genuinely non-obvious.

## Rationale edges

If the passage explains WHY a decision was made, extract a node for the reasoning and add a
\`RELATED_TO\` edge from that reasoning node to the concept it justifies. Use provenance
\`EXTRACTED\` when the rationale is stated directly, \`INFERRED\` when it is implied.

## Decision extraction rules

When a DECISION was actually made (not just discussed), extract a \`decision\` entity with:
- label: concise description of the decision (e.g. "Chose PostgreSQL over MongoDB")
- description: ≤140 char rationale
- Add \`DECIDED_BY\` edge to the person who made it (if named)
- Add \`APPLIED_TO\` edge to the project/service/process it governs
- Add \`SUPERSEDES\` edge if it explicitly replaces a prior decision

Only emit decision entities where a choice was ACTUALLY MADE — not proposed, not discussed.

## Confidence scoring rules

Never use 0.5 as a default score. Apply these precisely:
- \`EXTRACTED\` edges: confidence MUST be 1.0 (it is stated verbatim in the text)
- \`INFERRED\` with direct structural evidence: 0.8–0.9
- \`INFERRED\` with reasonable but uncertain inference: 0.6–0.7
- \`INFERRED\` when speculative: 0.4–0.5
- \`AMBIGUOUS\` edges: 0.1–0.3

## Output format

Return a single JSON object with exactly two keys: \`entities\` and \`relationships\`. No prose, no code fences.

## Rules

1. Deduplicate entities within a single response. Each (label, entity_type) pair appears once.
2. Every \`source\` and \`target\` in \`relationships\` MUST also appear in \`entities\`.
3. Labels are human-readable names as they appear in the text (canonical form, singular, title-case when appropriate). Do not invent identifiers.
4. If the passage contains no meaningful entities, return \`{"entities":[],"relationships":[]}\`.
5. Do not include quotes from the source text. Descriptions are your own concise summaries (≤ 140 chars).
6. Do not include PII you would not want logged. Anonymize email addresses and phone numbers.`;

// ── Decision-specific extraction prompt ────────────────────────────────────────
// Run in parallel with EXTRACTION_PROMPT on qualifying source types.
// Only activated for: notion, confluence, google_drive, sharepoint, gmail, slack

export const DECISION_EXTRACTION_PROMPT = `# Decision Record Extraction Prompt

You are a decision record extractor for organizational documents. Your job is to identify DECISIONS that were actually made — not discussed, not proposed, not pending — and extract them as structured entities.

## What counts as a decision

A decision is a RESOLVED CHOICE between two or more options where the text makes clear that one option was selected. Examples:
- "We decided to use PostgreSQL"
- "The team agreed to postpone the launch"
- "Engineering chose Kubernetes over ECS after evaluation"
- "Leadership approved moving to a microservices architecture"

NOT a decision: "We are considering X", "We should evaluate Y", "One option is Z"

## Entity types to extract

Only \`decision\` entities. Do not extract other entity types in this prompt.

## Relationship types to extract

- \`DECIDED_BY\` — source: decision, target: person (who made or approved it)
- \`APPLIED_TO\` — source: decision, target: project / service / process / team (what it governs)
- \`SUPERSEDES\` — source: new decision, target: prior decision label (if the text says it replaces a prior choice)

## Required fields per decision entity

- \`label\`: Concise summary of what was decided (≤ 100 chars, title-case)
- \`entity_type\`: always "decision"
- \`description\`: The rationale or context (≤ 140 chars)
- \`temporal_metadata\`: object with:
  - \`occurred_at\`: ISO date string if a date is mentioned, otherwise omit
  - \`decision_maker\`: name of the person who decided, if named
  - \`alternatives_considered\`: array of option labels that were NOT chosen
  - \`outcome\`: brief description of what happened as a result, if mentioned
  - \`confidence_of_date\`: 0.0–1.0 (1.0 if date is explicit, 0.5 if inferred from context, 0.0 if unknown)

## Output format

Return a single JSON object:
{
  "entities": [ { "label", "entity_type": "decision", "description", "temporal_metadata": {...} } ],
  "relationships": [ { "source", "source_entity_type": "decision", "target", "target_entity_type", "relation", "provenance", "confidence" } ]
}

No prose, no code fences. If no decisions are found, return {"entities":[],"relationships":[]}.

## Rules

1. Only emit a decision entity if you are confident a choice was made.
2. All relationship targets must be clearly mentioned in the text.
3. Do not fabricate decision_maker, occurred_at, or alternatives — omit if not stated.
4. Provenance for all edges from clearly stated decisions: EXTRACTED (confidence 1.0).`;

/** Source types that warrant decision extraction (documents with meeting notes, decisions, etc.) */
export const DECISION_SOURCE_TYPES = new Set([
  "notion",
  "confluence",
  "google_drive",
  "sharepoint",
  "gmail",
  "slack",
  "file_upload",
]);
