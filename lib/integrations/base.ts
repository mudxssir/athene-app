import 'server-only'
import { getConnectionToken } from '@/lib/nango/client'
import { getProviderConfig, type ProviderKey } from './providers'
import { Nango } from '@nangohq/node'
import { logger } from '@/lib/logger'

// ─── Data shape contract (P1-1, PLAN_A §0.1) ─────────────────────────────────

/**
 * Canonical data shape for every FetchedChunk.
 * All downstream routing — chunking strategy, embedding hint, extraction tier,
 * decision-prompt gate — switches on this value instead of provider strings.
 */
export type DataShape =
  | 'prose'       // documents, wiki pages, articles, notes
  | 'email'       // one message = one unit (Gmail, Outlook)
  | 'thread'      // chat conversations (Slack)
  | 'work_item'   // tickets, issues, PRs (Jira, Linear, GitHub)
  | 'record'      // CRM rows, calendar events — key-value units
  | 'tabular'     // datasets: warehouse tables, sheets, parsed tables
  | 'bi_artifact' // reports, dashboards, measures, model definitions
  | 'media'       // images/diagrams → captioned prose (Phase 5)
  | 'code'        // reserved — Phase 2+

/**
 * Deterministic owner annotation emitted by fetchers that have structured
 * owner fields (Jira assignee, Linear assignee, GitHub PR author, etc.).
 * Consumed by the KG builder to create OWNS/WORKS_ON edges without LLM extraction.
 * Populated in Phase 2; declared here as a placeholder so the type is stable.
 */
export interface StructuredOwner {
  person_label: string
  provider_account_id?: string
  /** Provider-reported email — drives org_member_identities auto-claim (P2-4). */
  provider_email?: string
  relation: 'OWNS' | 'WORKS_ON' | 'REPORTED_BY' | 'DECIDED_BY'
}

/**
 * Deterministic context envelope — breadcrumb + document-context line.
 * Constructed by the indexing pipeline (Phase 3); fetchers leave this undefined.
 * Declared here so FetchedChunk is forward-compatible.
 */
export interface ChunkContext {
  breadcrumb?: string
  doc_context?: string
}

// ─── Shared output type ─────────────────────────────────────────────────────

/**
 * Canonical chunk shape returned by every fetcher.
 * Content lives in RAM only — never written to the DB.
 *
 * REQUIRED fields after P1-2: every fetcher must declare `shape`.
 * The indexing pipeline reads `chunk.shape` for routing when
 * PIPELINE_SHAPE_ROUTING is on; legacy provider-string fallback is
 * retained until all fetchers are migrated (removed in P3).
 */
export interface FetchedChunk {
  /** Opaque ID — used by live-doc-fetch to re-fetch on query time */
  chunk_id: string
  /** Human-readable title shown in citations */
  title: string
  /** The actual content — RAM only, never written to DB */
  content: string
  /** Deep link back to the source */
  source_url: string
  /** Data shape — drives chunking strategy, embedding hint, extraction tier */
  shape: DataShape
  /** Pre-parsed ownership links (work_item fetchers; Phase 2 populates fully) */
  structured_owners?: StructuredOwner[]
  /** Context envelope (set by indexing pipeline in Phase 3; fetchers leave unset) */
  context?: ChunkContext
  /**
   * P3-6: provenance-only chunk — its content is stored in chunk_text but never
   * embedded (one row, embedding=null, needs_embedding=false, excluded from
   * vector search). Used for the stripped quoted tail + signature of an email so
   * the original stays retrievable without re-embedding the quoted chain.
   */
  skip_embedding?: boolean
  /** Lightweight metadata — NO body/content fields allowed */
  metadata: {
    provider: string
    resource_type: string
    last_modified?: string
    author?: string
    [key: string]: unknown
  }
}

/**
 * Signature for a background fetcher (full sync).
 */
export type ProviderFetcher = (
  connectionId: string,
  orgId: string,
  options?: { since?: string; limit?: number }
) => Promise<FetchedChunk[]>

/**
 * Signature for a live searcher (query-time, ephemeral).
 */
export type ProviderSearcher = (
  connectionId: string,
  orgId: string,
  query: string,
  options?: { limit?: number }
) => Promise<FetchedChunk[]>

// ─── Token helper ────────────────────────────────────────────────────────────

/**
 * Retrieves an OAuth access token for the given provider via Nango.
 * Centralizes auth so individual fetchers never touch Nango directly.
 *
 * Looks up the Nango `nangoIntegrationId` from the registry so callers
 * only need to pass the canonical ProviderKey (e.g. 'google', 'outlook').
 *
 * @param connectionId - The Nango connectionId tied to a specific user/org.
 * @param providerKey  - The canonical registry key (e.g. 'google', 'microsoft').
 * @param orgId        - The organization ID for ownership verification.
 * @returns The raw OAuth access token string.
 */
export async function getProviderToken(
  connectionId: string,
  providerKey: ProviderKey,
  orgId: string,
): Promise<string> {
  const nangoIntegrationId = getProviderConfig(providerKey).nangoIntegrationId
  return getConnectionToken(connectionId, nangoIntegrationId, orgId)
}

// ─── Metadata helper ─────────────────────────────────────────────────────────

/**
 * Fetches connection metadata from Nango.
 * Used to retrieve subdomains, account IDs, etc.
 * 🔒 Rule 1: Always pass orgId for verification.
 */
export async function getProviderMetadata(
  connectionId: string,
  providerKey: ProviderKey,
  orgId: string
): Promise<Record<string, any>> {
  if (!orgId) {
    throw new Error('orgId is required to fetch connection metadata');
  }

  const nangoSecretKey = process.env.NANGO_SECRET_KEY;
  if (!nangoSecretKey) {
    throw new Error('Missing NANGO_SECRET_KEY environment variable');
  }

  const nangoIntegrationId = getProviderConfig(providerKey).nangoIntegrationId;
  const nango = new Nango({ secretKey: nangoSecretKey });
  const connection = await nango.getConnection(nangoIntegrationId, connectionId);

  // Security check: verify metadata org_id matches
  if (connection.metadata?.org_id && connection.metadata.org_id !== orgId) {
    throw new Error('Unauthorized: Connection metadata orgId mismatch');
  }

  return {
    ...connection.metadata,
    ...connection.connection_config,
    ...(connection as any).credentials?.raw,
  };
}

// ─── Retry + rate-limit fetch ────────────────────────────────────────────────

export interface BaseFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  body?: unknown
  /** Max retries on 429 / 5xx. Default 3. */
  maxRetries?: number
  /** If true, return the raw Response instead of parsing JSON. */
  rawResponse?: boolean
  /** Request timeout in ms. Default 30 000. Binary downloads should pass 120 000. */
  timeoutMs?: number
}

/**
 * Shared HTTP fetch with automatic retry on rate-limits (429) and
 * server errors (5xx). Every provider fetcher should use this instead
 * of calling fetch() directly.
 *
 * Retry strategy:
 * - 429: Respect Retry-After header, fall back to 2s.
 * - 5xx: Exponential backoff (500ms, 1s, 2s, …).
 *
 * @param url     - The full API endpoint URL.
 * @param options - Method, headers, body, retry config.
 * @returns Parsed JSON response of type T.
 */
export async function baseFetch<T = unknown>(
  url: string,
  options: BaseFetchOptions = {},
): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    maxRetries = 3,
    rawResponse = false,
    timeoutMs = 30_000,
  } = options

  let attempt = 0

  while (attempt <= maxRetries) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`[baseFetch] Request timed out after ${timeoutMs}ms`)), timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    // ── Rate limited — back off and retry ────────────────────────────────
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After')
      const retryAfterMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : 2000
      logger.warn({ url, retryAfterMs, attempt: attempt + 1, maxRetries }, '[baseFetch] 429 rate-limited, retrying')
      await sleep(retryAfterMs)
      attempt++
      continue
    }

    // ── Server error — exponential backoff ───────────────────────────────
    if (res.status >= 500 && attempt < maxRetries) {
      const backoffMs = 2 ** attempt * 500
      logger.warn({ url, status: res.status, backoffMs, attempt: attempt + 1, maxRetries }, '[baseFetch] server error, retrying')
      await sleep(backoffMs)
      attempt++
      continue
    }

    // ── Non-retryable error ──────────────────────────────────────────────
    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error')
      const err = new Error(
        `[baseFetch] ${method} ${url} → ${res.status}: ${text}`,
      )
      ;(err as any).status = res.status
      throw err
    }

    // ── Success ──────────────────────────────────────────────────────────
    if (rawResponse) {
      return res as unknown as T
    }

    // Handle empty responses (e.g. 204 No Content from DELETE)
    const contentType = res.headers?.get('content-type') ?? 'application/json'
    if (
      res.status === 204 ||
      !contentType.includes('application/json')
    ) {
      const text = await res.text()
      return text as unknown as T
    }

    return res.json() as Promise<T>
  }

  throw new Error(`[baseFetch] Max retries (${maxRetries}) exceeded for ${method} ${url}`)
}

/**
 * Variant of baseFetch that returns the raw Response object.
 * Useful for binary downloads (PDFs, images) where we need the stream.
 */
export async function baseFetchRaw(
  url: string,
  options: Omit<BaseFetchOptions, 'rawResponse'> = {},
): Promise<Response> {
  return baseFetch<Response>(url, { ...options, rawResponse: true })
}

// ─── Metadata safety guard ───────────────────────────────────────────────────

/**
 * Keys that must never appear in FetchedChunk.metadata.
 * Content must stay in the `content` field only — never in metadata.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  'content',
  'body',
  'text',
  'raw',
  'html',
  'markdown',
  'plaintext',
])

/**
 * Validates that no content-bearing keys have leaked into metadata.
 * Call this when constructing FetchedChunk objects to catch bugs early.
 *
 * @throws Error if a forbidden key is found.
 */
export function assertSafeMetadata(
  metadata: Record<string, unknown>,
): void {
  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `[baseFetch] Forbidden metadata key "${key}" — content must never be stored in metadata`,
      )
    }
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Skip-sentinel detection (P0-5, audit D11) ───────────────────────────────

/**
 * Placeholder strings emitted by parsers when content could not be extracted.
 * These must never be embedded — they pollute retrieval with meaningless hits
 * (e.g. "[Unsupported file type: .pptx — skipped]" matching "pptx" queries).
 */
const SKIP_SENTINEL_PREFIXES = [
  '[Unsupported binary format:',
  '[Unsupported file type:',
  '[PDF skipped:',
  '[PDF contains no extractable text',
  '[PDF text extraction failed]',
  '[DOCX contains no extractable text]',
  '[DOCX text extraction failed]',
  '[XLSX contains no extractable text]',
  '[XLSX text extraction failed]',
  '[Google Drive Folder',
  '[Google Sheet — no content]',
]

/**
 * True when content is a parser skip-sentinel rather than real document text.
 * The length guard prevents false positives on real documents that merely
 * begin with bracketed text — sentinels are short, single-line placeholders.
 */
export function isSkipSentinel(content: string): boolean {
  const t = content.trim()
  return t.length > 0 && t.length < 200 && SKIP_SENTINEL_PREFIXES.some((p) => t.startsWith(p))
}
