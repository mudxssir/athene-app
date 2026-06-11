# PLAN B — Open-Source Module Integration, per Data Shape

_2026-06-11. Selects the OSS components Plan A consumes, and specifies the Python parsing
sidecar that hosts them. Every pick lists license, role, and the fallback when it is
unavailable. Split: Part I components feeding **vector embeddings** (parsing, cleaning,
chunking), Part II components feeding **KG construction**._

**Selection criteria:** permissive license (MIT/Apache preferred — we are a commercial
product), active maintenance, self-hostable inside our boundary (data never leaves the org's
deployment except to the org's own LLM/embedding providers), quality benchmarks over hype.

---

## 0. The Parsing Sidecar (`athene-parse`)

A small FastAPI service, deployed next to the app (Fly.io / Cloud Run, private network,
mTLS or signed-token auth from the sync workers). Stateless: receives bytes, returns JSON,
stores nothing, logs no content. This is the single home for all Python-only OSS below.

```
POST /parse      { filename, bytes (multipart) } → { markdown, headings[], tables[ParsedTable],
                                                     pictures[{page,bbox,bytes?}], meta, parser_used }
POST /chunk      { text|markdown, policy } → { chunks[{text, heading_trail, start, end}] }
POST /ocr        { image bytes } → { text, confidence }
POST /email/clean{ raw body, content_type } → { reply_text, signature, quoted_tail }
POST /graph/leiden { nodes[], edges[] } → { communities: hierarchical levels }   (Plan C)
GET  /healthz
```

Operational spec: 2 replicas min; request cap 80 MB; per-request timeout 120 s with
streaming-poll for big PDFs (job id + poll, mirroring the existing LlamaParse client
pattern in `llamaparse-client.ts`); concurrency limited per worker (parsing is CPU/RAM
heavy — semaphore 4); OOM guard via container memory limits + worker recycling
(`max_requests`); version pinning via lockfile; image scanned in CI.

**Degradation contract (critical):** the TS app treats the sidecar as enhancement, not
dependency. Every call site keeps the current in-process fallback (pdf-parse, mammoth, xlsx,
plain heuristic chunking). Circuit breaker in `lib/integrations/sidecar-client.ts`: 3
consecutive failures → 5-minute open state → fallbacks, with `parser_used='fallback'` stamped
into chunk metadata + telemetry, so quality regressions are attributable. A sidecar outage
degrades parse quality; it never stops a sync.

---

## PART I — Components for the Embedding Pipeline

### 1. prose / binary containers (PDF, DOCX, PPTX, HTML…)

| Component | License | Role |
|---|---|---|
| **Docling** (docling-project/docling, IBM) | MIT | **Primary parser** for PDF/DOCX/PPTX/XLSX/HTML/images: best-in-class layout analysis, TableFormer table structure, reading order, OCR integration, heading hierarchy + per-element provenance (page/bbox) — exactly what the context-envelope breadcrumbs and media pipeline need. ~45 pages/s on GPU, acceptable CPU throughput for sync workloads. |
| **MarkItDown** (microsoft/markitdown) | MIT | **Breadth fallback**, not the PDF engine (benchmarks: fastest, weakest on tables/images/layout). Used for the long tail Docling doesn't cover: EPUB, MSG, audio-transcript containers, ZIP walk-through, odd Office variants. |
| **unstructured** (Unstructured-IO/unstructured) | Apache-2.0 | Optional third lane: typed elements (Title/NarrativeText/Table/ListItem) when Docling output is ambiguous; also its `chunk_by_title` validates our structural chunker. Heavyweight dependency tree — include only if Docling gaps appear in pilot fixtures. |
| **RapidOCR / Tesseract** (via Docling OCR backends) | Apache-2.0 | OCR for scanned PDFs and standalone images. |

Explicitly rejected: **marker / surya** (GPL-3.0 + revenue-clause licensing — incompatible
with a commercial closed-source product), **PyMuPDF/pymupdf4llm** (AGPL — same problem),
**Apache Tika** (JVM operational weight for no quality win over Docling).

Replacement map in our code: `parseWithLlamaParse` becomes lane 2 (hosted, only when org
opts into external processing); `pdf-parse`/`mammoth`/`xlsx` paths in `drive-fetcher.ts` and
`microsoft/document-parser.ts` become the in-process fallback lane 3. Drive/OneDrive/
SharePoint/upload binary buffers all route: sidecar Docling → LlamaParse (if org-permitted)
→ TS fallback.

### 2. email

| Component | License | Role |
|---|---|---|
| **Talon** (mailgun/talon) | Apache-2.0 | Reply extraction + signature detection (`/email/clean`). Solves the quoted-chain noise problem (Plan A email shape). Older but stable; its regex/ML hybrid is still the best OSS option. |
| **mailparser** (npm, TS side) | MIT | MIME tree walking for raw RFC822 when Graph/Gmail APIs hand us full messages; replaces hand-rolled `extractBodyFromPayload` multipart logic where convenient. |

Edge cases handled at the module boundary: non-Latin signatures (Talon misses → cap
strip-length at 30% of body), inline-reply style (interleaved quoting — Talon handles),
HTML-only bodies (strip via existing `stripOutlookHtml` first, then Talon on text).

### 3. chunking (all textual shapes)

| Component | License | Role |
|---|---|---|
| **Chonkie** (chonkie-inc/chonkie) | MIT | `/chunk` engine: RecursiveChunker (structural fallback), SemanticChunker (embedding-drift breakpoints for heading-poor prose), SentenceChunker. Fast, minimal deps, benchmarked. Policy engine from Plan A §0.4 maps onto its chunker classes; we keep policy in TS and only execute splitting in the sidecar. |
| **gpt-tokenizer** (already vendored, TS) | MIT | Token accounting stays in-process (`lib/langgraph/tools/chunker.ts`) — sidecar returns text; TS enforces token budgets, so a sidecar version drift can never silently change token math. |

**Late chunking note:** late chunking needs no OSS module — it's a flag on the Jina v3
embeddings API (`late_chunking: true`) with our parent-window batching (Plan A Part I).
The jinaai/late-chunking repo is reference material only. If we ever self-host embeddings,
implement via long-context pooling in TEI (below).

### 4. embeddings serving (sovereignty tier)

| Component | License | Role |
|---|---|---|
| **text-embeddings-inference (TEI)** (huggingface) | Apache-2.0 | Self-hosted embedding server for orgs that refuse external embedding APIs. Pinned model per org still applies. |
| **nomic-embed-text-v1.5** | Apache-2.0 | The self-host default (768-dim Matryoshka, prefix-based task types `search_document:`/`search_query:` — maps cleanly onto our hint plumbing). |
| **BGE-M3 / bge-base-en-v1.5** (BAAI) | MIT | Alternative self-host lane; bge-base already wired as the Xenova local fallback. |

Jina v3 stays the pinned default via API (its open weights are CC-BY-NC — fine to *call*,
not fine to self-host commercially; the sovereignty lane uses nomic/BGE instead). The
`embedding_model` column from Plan A makes all of this switchable per org with a re-embed job.

### 5. media (vision→text)

No OSS vision model self-hosted in v1 — captions go through `resolveModelClient` (BYOK,
vision-capable tier). OSS kept on the bench if cost forces local: **Moondream2** (Apache-2.0,
small VLM, good captions), **DePlot/MatCha** (Apache-2.0, chart→table extraction — pairs
beautifully with our tabular engine for BI chart PNGs: chart → table → stats/sample/agg
chunks). Decision gate: if monthly caption spend per org exceeds the configured budget 2
months running, stand up Moondream in the sidecar.

---

## PART II — Components for KG Construction

### 1. Extraction assistance (cheaper + higher-recall entity layer)

| Component | License | Role |
|---|---|---|
| **GLiNER** (urchade/GLiNER) | Apache-2.0 | Zero-shot NER, ONNX-runnable in the sidecar (or transformers.js in TS for small models). Runs on **Tier B shapes** (threads, records) as a pre-LLM gate upgrade: regex gate says "maybe" → GLiNER confirms person/org/project mentions cheaply → only then the LLM extraction call fires. Cuts false-positive LLM calls; also supplies candidate entity spans to the prompt (recall boost). |
| **fastcoref** | MIT | Coreference resolution on prose/email/thread before extraction ("she approved it" → "Dana approved the migration") — directly improves edge recall on chat, where most blocker/decision language is pronoun-heavy. Sidecar `/nlp/coref`, applied to Tier A/B text above signal threshold. |

Rejected for now: **REBEL/Triplex** relation-extraction models (fixed schema vocabularies
fight our typed relation set; the LLM with module addenda wins on flexibility),
**spaCy** pipelines (GLiNER covers NER zero-shot without per-org model training).

### 2. Graph algorithms & store

| Component | License | Role |
|---|---|---|
| **graphology + graphology-communities-louvain** (current) | MIT | Stays for incremental, per-batch community assignment (cheap, in-process). |
| **igraph + leidenalg** (sidecar `/graph/leiden`) | GPL-2.0 — **service-isolated**: called over HTTP, never linked into our distributed code; standard practice, but flag for counsel review | **Leiden hierarchical communities** for Plan C: multi-level partitions (GraphRAG-style), strictly better connected communities than Louvain. Runs as a batch job per org. If license review objects: `graspologic` (MIT) leiden implementation instead — slightly slower, zero license question. **Default to graspologic; igraph only if perf demands.** |
| **Postgres (current kg_nodes/kg_edges)** | — | Remains the graph store. Evaluated and rejected: Neo4j (AGPL/commercial split + second database + RLS reimplementation), Apache AGE (immature RLS story). Our traversals are 2-hop bounded (my-work) and batch analytics (communities) — Postgres + recursive CTEs + the sidecar handle both. Revisit only if traversal depth requirements exceed 4 hops interactively. |

### 3. Hierarchical summarization (consumed by Plan C)

| Component | License | Role |
|---|---|---|
| **Microsoft GraphRAG** (microsoft/graphrag) | MIT | **Design source, not runtime dependency.** We adopt: Leiden community hierarchy → per-community "community reports" (LLM summaries with rating/importance) → map-reduce global query answering. Their prompts and report schema are MIT — fork the report-generation prompt into `lib/knowledge-graph/prompts/`. We do NOT adopt its indexing pipeline (parquet-based, batch-only, no multi-tenancy/RLS). |
| **LightRAG** (HKUDS/LightRAG) | MIT | Reference for the cheaper dual-level retrieval pattern (entity-level + topic-level keys) if GraphRAG-style community reports prove too costly per org. Bench both on the pilot org in Phase 5. |

### 4. Entity resolution / identity

| Component | License | Role |
|---|---|---|
| **Splink** (moj-analytical-services/splink) | MIT | Probabilistic record linkage for the identity table backfill (org_member ↔ provider accounts ↔ KG person nodes) when an org connects with thousands of historical actors. Runs as a one-shot sidecar job per org onboarding; ongoing linkage stays with our alias/embedding resolver (`entity-resolver.ts`) + deterministic `provider_account_id` matches. |

### Integration sequencing & risk register

| Risk | Mitigation |
|---|---|
| Sidecar becomes a single point of failure | Degradation contract (§0): circuit breaker + in-process fallbacks; sync never blocks |
| Dependency sprawl in one Python image | Two images if needed: `parse` (Docling/MarkItDown/Talon/Chonkie) and `nlp` (GLiNER/coref/leiden); shared FastAPI scaffold |
| License drift in transitive deps | CI license scanner (allow-list MIT/Apache/BSD/ISC); igraph isolated or replaced by graspologic |
| Parser version bumps change chunk output silently | `parser_used` + `parser_version` stamped per chunk; `PIPELINE_VERSION` bump policy from Plan A §0.2 governs re-index |
| Content exfiltration surface | Sidecar private-network only, authenticated, no logging of bodies, no disk writes; pen-test item for SOC 2 |
| Throughput regression vs current inline parsing | Batch endpoint (`/parse` accepts up to 20 files), parallel replicas; benchmark gate: ≥ current LlamaParse path throughput on pilot fixture set |
