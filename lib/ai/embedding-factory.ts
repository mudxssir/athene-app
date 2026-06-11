// ============================================================
// embedding-factory.ts — Provider-agnostic embedding layer
//
// Priority (system):
//   1. JINA_API_KEY  → Jina AI  (jina-embeddings-v3, 768 dims, free 1M/mo)
//   2. TOGETHER_API_KEY → Together AI  (nomic-embed-text-v1.5, 768 dims)
//   3. NOMIC_API_KEY → Nomic Atlas API (nomic-embed-text-v1.5, 768 dims)
//
// Per-org BYOK (checked before system env):
//   • provider=openai  → text-embedding-3-small with dimensions:768 (MRL)
//   • provider=jina    → Jina AI with org key
//
// All paths produce 768-dim vectors to match the DB column.
// ============================================================

import OpenAI from "openai"
import { supabaseAdmin } from "@/lib/supabase/server"
import { logger } from "@/lib/logger"
import { deriveOrgKey, getMasterKey } from "@/lib/auth/kms"

// ---- Dimension constant -------------------------------------------------

/** Must match document_embeddings.embedding vector(N) in the DB schema */
export const EMBEDDING_DIMS = parseInt(process.env.EMBEDDING_DIMS ?? "768")

/**
 * Hint that lets the Google embedding provider select the optimal task type.
 * Only google (text-embedding-004) uses this; other providers ignore it.
 * - "document"   → RETRIEVAL_DOCUMENT (default, best for long-form prose)
 * - "structured" → SEMANTIC_SIMILARITY (best for CRM key-value records)
 * - "query"      → RETRIEVAL_QUERY (used at search time, not indexing)
 */
export type EmbeddingHint = "document" | "structured" | "query"

// ---- Provider config types ---------------------------------------------

type EmbeddingProviderName = "openai" | "jina" | "together" | "nomic" | "google"

interface EmbeddingConfig {
  provider: EmbeddingProviderName
  model: string
  dims: number
  apiKey: string
  baseUrl?: string
}

// ---- System default resolution -----------------------------------------

function resolveSystemConfig(): EmbeddingConfig | null {
  if (process.env.GOOGLE_API_KEY) {
    return {
      provider: "google",
      model: "text-embedding-004",
      dims: EMBEDDING_DIMS,
      apiKey: process.env.GOOGLE_API_KEY,
    }
  }
  if (process.env.JINA_API_KEY) {
    return {
      provider: "jina",
      model: "jina-embeddings-v3",
      dims: EMBEDDING_DIMS,
      apiKey: process.env.JINA_API_KEY,
    }
  }
  if (process.env.TOGETHER_API_KEY) {
    return {
      provider: "together",
      model: "togethercomputer/m2-bert-80M-8k-base",
      dims: EMBEDDING_DIMS,
      apiKey: process.env.TOGETHER_API_KEY,
      baseUrl: "https://api.together.xyz/v1",
    }
  }
  if (process.env.NOMIC_API_KEY) {
    return {
      provider: "nomic",
      model: "nomic-embed-text-v1.5",
      dims: EMBEDDING_DIMS,
      apiKey: process.env.NOMIC_API_KEY,
      baseUrl: "https://api-atlas.nomic.ai/v1",
    }
  }
  return null
}

// ---- BYOK resolution ---------------------------------------------------

type DecryptedKeyRow = { provider: string; plaintext: string }

async function fetchByokEmbeddingConfig(orgId: string): Promise<EmbeddingConfig | null> {
  if (!orgId) return null
  let orgKey: string;
  try {
    orgKey = deriveOrgKey(getMasterKey(), orgId);
  } catch {
    logger.error({ orgId }, "[EmbeddingFactory] KMS_KEY is not set — cannot decrypt BYOK embedding key; falling back to system provider. Set KMS_KEY in environment.")
    return null
  }

  const { data, error } = await supabaseAdmin.rpc("get_decrypted_llm_key", {
    p_org_id: orgId,
    p_kms_key: orgKey,
  })

  if (error) {
    logger.warn({ orgId, err: error.message }, "[EmbeddingFactory] get_decrypted_llm_key RPC failed — falling back to system embedding provider")
    return null
  }

  const rows = (data ?? []) as DecryptedKeyRow[]

  // Prefer BYOK OpenAI (supports MRL dimension reduction)
  const openaiRow = rows.find((r) => r.provider === "openai")
  if (openaiRow?.plaintext) {
    return {
      provider: "openai",
      model: "text-embedding-3-small",
      dims: EMBEDDING_DIMS,
      apiKey: openaiRow.plaintext,
    }
  }

  // BYOK Jina
  const jinaRow = rows.find((r) => r.provider === "jina")
  if (jinaRow?.plaintext) {
    return {
      provider: "jina",
      model: "jina-embeddings-v3",
      dims: EMBEDDING_DIMS,
      apiKey: jinaRow.plaintext,
    }
  }

  return null
}

// ---- Local (Xenova/Transformers.js) provider ---------------------------

// Cached pipeline instance — loaded once, reused across calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _localPipeline: any = null

async function getLocalPipeline() {
  if (_localPipeline) return _localPipeline
  // Dynamic import keeps this out of the client bundle entirely.
  const { pipeline, env } = await import("@xenova/transformers")
  // Disable GPU (not available in Node.js server) and remote model fetching warnings
  env.useBrowserCache = false
  env.allowLocalModels = false
  // BGE-base-en-v1.5 — 768-dim, ~270 MB, good semantic quality
  _localPipeline = await pipeline("feature-extraction", "Xenova/bge-base-en-v1.5", {
    quantized: true, // ~68 MB quantized int8 version
  })
  return _localPipeline
}

async function embedWithLocal(texts: string[]): Promise<number[][]> {
  const extractor = await getLocalPipeline()
  const results: number[][] = []
  for (const text of texts) {
    const output = await extractor(text, { pooling: "mean", normalize: true })
    results.push(Array.from(output.data) as number[])
  }
  return results
}

// ---- Provider implementations ------------------------------------------

async function embedWithOpenAI(
  texts: string[],
  config: EmbeddingConfig
): Promise<number[][]> {
  const client = new OpenAI({ apiKey: config.apiKey })
  const res = await client.embeddings.create({
    model: config.model,
    input: texts,
    dimensions: config.dims,
  })
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

async function embedWithOpenAICompat(
  texts: string[],
  config: EmbeddingConfig
): Promise<number[][]> {
  // Together AI and Nomic AI both expose an OpenAI-compatible /v1/embeddings endpoint
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl })
  const res = await client.embeddings.create({ model: config.model, input: texts })
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

async function embedWithGoogle(
  texts: string[],
  config: EmbeddingConfig,
  hint?: EmbeddingHint
): Promise<number[][]> {
  const { GoogleGenerativeAI, TaskType } = await import("@google/generative-ai")
  const genAI = new GoogleGenerativeAI(config.apiKey)
  const model = genAI.getGenerativeModel({ model: config.model })
  const taskType =
    hint === "query" ? TaskType.RETRIEVAL_QUERY
    : hint === "structured" ? TaskType.SEMANTIC_SIMILARITY
    : TaskType.RETRIEVAL_DOCUMENT
  const BATCH = 96
  const results: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const res = await model.batchEmbedContents({
      requests: slice.map((text) => ({
        content: { parts: [{ text }], role: "user" },
        taskType,
      })),
    })
    res.embeddings.forEach((emb) => results.push(emb.values))
  }
  return results
}

async function embedWithJina(
  texts: string[],
  config: EmbeddingConfig,
  hint?: EmbeddingHint,
  lateChunking = false,
): Promise<number[][]> {
  const response = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: texts,
      dimensions: config.dims,
      // P0-2 (audit D5): queries must use the asymmetric query task, not passage
      task: hint === "query" ? "retrieval.query" : "retrieval.passage",
      // P1-9: late chunking — batch children per parent so each child's embedding
      // is conditioned on the full sibling context (bidirectional attention).
      // Only set when caller is batching chunks from ONE parent document.
      ...(lateChunking ? { late_chunking: true } : {}),
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`[EmbeddingFactory] Jina API error ${response.status}: ${err}`)
  }

  const data = await response.json() as { data: Array<{ embedding: number[]; index: number }> }
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

// ---- Provider call with retry ------------------------------------------

const MAX_PROVIDER_RETRIES = 2

async function callProviderWithRetry(
  texts: string[],
  config: EmbeddingConfig,
  hint?: EmbeddingHint,
  lateChunking = false,
): Promise<number[][]> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt++) {
    try {
      switch (config.provider) {
        case "google":
          return await embedWithGoogle(texts, config, hint)
        case "openai":
          return await embedWithOpenAI(texts, config)
        case "jina":
          return await embedWithJina(texts, config, hint, lateChunking)
        case "together":
        case "nomic":
          return await embedWithOpenAICompat(texts, config)
      }
    } catch (err) {
      lastErr = err
      if (attempt < MAX_PROVIDER_RETRIES) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
      }
    }
  }
  throw lastErr
}

// ---- Core embed function -----------------------------------------------

/** Embedding output plus provenance of the model that produced it (P0-3). */
export interface EmbedDetailedResult {
  embeddings: number[][]
  /** Model id actually used (e.g. "jina-embeddings-v3", "bge-base-en-v1.5-local"). */
  model: string
  provider: string
}

const LOCAL_MODEL_ID = "bge-base-en-v1.5-local"

async function embedTexts(
  texts: string[],
  orgId?: string,
  hint?: EmbeddingHint,
  lateChunking = false,
): Promise<EmbedDetailedResult> {
  if (texts.length === 0) return { embeddings: [], model: "none", provider: "none" }

  // 1. Try per-org BYOK first
  const byokConfig = orgId
    ? await fetchByokEmbeddingConfig(orgId).catch(() => null)
    : null

  // 2. Build fallback chain: BYOK → system providers in priority order
  const systemConfig = resolveSystemConfig()
  const candidates: EmbeddingConfig[] = []

  if (byokConfig) candidates.push(byokConfig)
  if (systemConfig) candidates.push(systemConfig)

  // Add remaining system providers not already in the chain
  const systemFallbacks: Array<() => EmbeddingConfig | null> = [
    () => process.env.GOOGLE_API_KEY ? { provider: "google", model: "text-embedding-004", dims: EMBEDDING_DIMS, apiKey: process.env.GOOGLE_API_KEY! } : null,
    () => process.env.JINA_API_KEY ? { provider: "jina", model: "jina-embeddings-v3", dims: EMBEDDING_DIMS, apiKey: process.env.JINA_API_KEY! } : null,
    () => process.env.TOGETHER_API_KEY ? { provider: "together", model: "togethercomputer/m2-bert-80M-8k-base", dims: EMBEDDING_DIMS, apiKey: process.env.TOGETHER_API_KEY!, baseUrl: "https://api.together.xyz/v1" } : null,
    () => process.env.NOMIC_API_KEY ? { provider: "nomic", model: "nomic-embed-text-v1.5", dims: EMBEDDING_DIMS, apiKey: process.env.NOMIC_API_KEY!, baseUrl: "https://api-atlas.nomic.ai/v1" } : null,
  ]

  for (const fn of systemFallbacks) {
    const c = fn()
    if (c && !candidates.some(x => x.provider === c.provider && x.apiKey === c.apiKey)) {
      candidates.push(c)
    }
  }

  // 3. Try each API provider in order, falling back on failure.
  // Late chunking is only passed to Jina (other providers silently ignore it via callProviderWithRetry).
  let lastErr: unknown
  for (const config of candidates) {
    try {
      const embeddings = await callProviderWithRetry(texts, config, hint, lateChunking)
      // P0-7 (audit D6 exposure): fallback activation means this batch was embedded by a
      // different model than the org's primary — a mixed-vector-space event. Loud until
      // P1 replaces silent fallback with a same-model retry queue.
      if (config !== candidates[0]) {
        logger.warn(
          {
            usedProvider: config.provider,
            usedModel: config.model,
            primaryProvider: candidates[0].provider,
            primaryModel: candidates[0].model,
            orgId: orgId ?? null,
            batchSize: texts.length,
          },
          "[EmbeddingFactory] FALLBACK ACTIVATED — batch embedded by non-primary model (mixed vector space risk)"
        )
      }
      return { embeddings, model: config.model, provider: config.provider }
    } catch (err) {
      lastErr = err
      logger.warn(
        { provider: config.provider, err: err instanceof Error ? err.message : String(err) },
        "[EmbeddingFactory] Provider failed — trying next in fallback chain"
      )
    }
  }

  // 4. Final fallback: local Xenova/BGE inference (no API key needed, ~68 MB model)
  logger.warn(
    { orgId: orgId ?? null, batchSize: texts.length },
    "[EmbeddingFactory] All API providers failed — falling back to local Xenova/bge-base-en-v1.5 model (mixed vector space risk)"
  )
  try {
    const embeddings = await embedWithLocal(texts)
    return { embeddings, model: LOCAL_MODEL_ID, provider: "local" }
  } catch (localErr) {
    lastErr = localErr
  }

  throw new Error(
    `[EmbeddingFactory] All embedding providers (including local) exhausted. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  )
}

// ---- Startup assertion --------------------------------------------------

function assertDims(vec: number[]): void {
  if (vec.length !== EMBEDDING_DIMS) {
    throw new Error(
      `[EmbeddingFactory] Embedding dimension mismatch: provider returned ${vec.length}-dim vectors ` +
      `but DB schema expects vector(${EMBEDDING_DIMS}). ` +
      `Check EMBEDDING_DIMS env var and that the configured provider matches the migration.`
    )
  }
}

// ---- Cold-start provider visibility ------------------------------------

// Fires once per process: logs which embedding provider is active so that
// dimension mismatches are diagnosable from boot logs before any search
// query reaches the DB.  Does NOT call the provider API — resolves config only.
let _providerLogged = false

export async function logEmbeddingProviderInfo(orgId?: string): Promise<void> {
  if (_providerLogged) return
  _providerLogged = true

  const byok = orgId ? await fetchByokEmbeddingConfig(orgId).catch(() => null) : null
  const system = resolveSystemConfig()
  const active = byok ?? system

  if (active) {
    logger.info(
      { provider: active.provider, model: active.model, dims: active.dims, source: byok ? "byok" : "system" },
      "[EmbeddingFactory] Active provider on startup"
    )
  } else {
    logger.warn(
      { dims: EMBEDDING_DIMS },
      "[EmbeddingFactory] No API provider configured — will use local Xenova/bge fallback"
    )
  }
}

// ---- Public API --------------------------------------------------------

/** Embed a single text string. Uses org BYOK if orgId provided. */
export async function embed(text: string, orgId?: string, hint?: EmbeddingHint): Promise<number[]> {
  // Log provider once on first real call so cold-start logs show active config.
  logEmbeddingProviderInfo(orgId).catch(() => undefined)
  const { embeddings } = await embedTexts([text], orgId, hint)
  assertDims(embeddings[0])
  return embeddings[0]
}

/** Embed multiple texts in one API call. Uses org BYOK if orgId provided. */
export async function embedBatch(
  texts: string[],
  orgId?: string,
  hint?: EmbeddingHint
): Promise<number[][]> {
  const { embeddings } = await embedTexts(texts, orgId, hint)
  if (embeddings.length > 0) assertDims(embeddings[0])
  return embeddings
}

/**
 * Like embedBatch, but also reports which model produced the vectors so callers
 * can persist embedding provenance (P0-3: document_embeddings.embedding_model).
 */
export async function embedBatchDetailed(
  texts: string[],
  orgId?: string,
  hint?: EmbeddingHint
): Promise<EmbedDetailedResult> {
  const result = await embedTexts(texts, orgId, hint)
  if (result.embeddings.length > 0) assertDims(result.embeddings[0])
  return result
}

/**
 * P1-9: Late-chunking variant of embedBatchDetailed.
 *
 * All texts MUST be children of the SAME parent document. When the active
 * provider is Jina (jina-embeddings-v3), the batch is submitted with
 * `late_chunking: true` so each child's embedding is conditioned on the
 * full sibling context rather than being computed in isolation.
 *
 * Falls back to standard batch embedding for non-Jina providers (no error —
 * late chunking is a quality upgrade, not a correctness requirement).
 * Falls back to standard batch embedding if any provider call fails.
 *
 * Applies to shapes prose / email / thread / work_item where context between
 * chunks strongly affects meaning (pronouns, references, implicit context).
 */
export async function embedBatchLateChunking(
  texts: string[],
  orgId?: string,
  hint?: EmbeddingHint
): Promise<EmbedDetailedResult> {
  try {
    const result = await embedTexts(texts, orgId, hint, /* lateChunking */ true)
    if (result.embeddings.length > 0) assertDims(result.embeddings[0])
    return result
  } catch (err) {
    // If late-chunking call fails, fall back to standard batch (never drop the doc)
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), orgId: orgId ?? null, batchSize: texts.length },
      "[EmbeddingFactory] Late-chunking call failed — falling back to standard batch embedding"
    )
    return embedBatchDetailed(texts, orgId, hint)
  }
}
