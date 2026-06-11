// lib/integrations/sidecar-client.ts — P1-11
// Typed HTTP client for the athene-parse sidecar service.
//
// Sidecar is private-network only; the URL and token are injected via env.
// Circuit breaker: 3 consecutive failures → open for 5 min → half-open test.
// Byte-size cap: 80 MB (matching the sidecar limit; rejected locally to avoid
// the network hop entirely).
// All content fields are omitted from logs; only metadata (size, duration) is
// logged.

import 'server-only'
import { logger } from '@/lib/logger'

// ── Config ────────────────────────────────────────────────────────────────────

// Read env vars lazily (inside functions) so that tests can set process.env
// in beforeEach and have it take effect without module re-import.
function getSidecarUrl(): string   { return process.env.SIDECAR_URL ?? '' }
function getSidecarToken(): string { return process.env.SIDECAR_AUTH_TOKEN ?? '' }

const TIMEOUT_MS = 120_000          // 120 s — Docling on large PDFs is slow
const MAX_BYTES  = 80 * 1024 * 1024 // 80 MB

// ── Circuit breaker ───────────────────────────────────────────────────────────

const CB_THRESHOLD    = 3
const CB_OPEN_MS      = 5 * 60 * 1000  // 5 min

interface CBState {
  state: 'closed' | 'open' | 'half-open'
  failures: number
  openedAt: number
}

const _cb: CBState = { state: 'closed', failures: 0, openedAt: 0 }

function cbAvailable(): boolean {
  if (_cb.state === 'closed') return true
  if (_cb.state === 'open') {
    if (Date.now() - _cb.openedAt >= CB_OPEN_MS) {
      _cb.state = 'half-open'
      return true
    }
    return false
  }
  return true // half-open: let one request through
}

function cbSuccess(): void {
  _cb.state = 'closed'
  _cb.failures = 0
}

function cbFailure(): void {
  _cb.failures++
  if (_cb.failures >= CB_THRESHOLD) {
    _cb.state = 'open'
    _cb.openedAt = Date.now()
    logger.warn(
      { failures: _cb.failures, openDurationMs: CB_OPEN_MS },
      '[sidecar] Circuit breaker opened — sidecar unreachable, will retry in 5 min'
    )
  }
}

// ── Exported types ────────────────────────────────────────────────────────────

export interface ParseResult {
  markdown: string
  parser_used: 'docling' | 'markitdown' | 'plain'
  parser_version: string
  file_size_bytes: number
  duration_ms: number
}

export interface ChunkItem {
  text: string
  token_count: number
}

export interface ChunkResult {
  chunks: ChunkItem[]
  strategy_used: string
  duration_ms: number
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isConfigured(): boolean {
  return !!(getSidecarUrl() && getSidecarToken())
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getSidecarToken()}`,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if the sidecar is configured and its circuit breaker is closed.
 * Use this before calling parse() or chunkSemantic() to avoid unnecessary work.
 */
export function sidecarAvailable(): boolean {
  return isConfigured() && cbAvailable()
}

/**
 * Parse a binary document buffer to markdown via the sidecar.
 * Returns null if the sidecar is unavailable, unconfigured, or over the byte cap.
 * Caller must treat null as a signal to fall through to the inline parser.
 */
export async function parseSidecar(
  buffer: Buffer,
  filename: string,
  orgId?: string,
): Promise<ParseResult | null> {
  if (!isConfigured()) return null
  if (!cbAvailable()) {
    logger.warn({ filename }, '[sidecar] Circuit breaker open — skipping parse')
    return null
  }
  if (buffer.length > MAX_BYTES) {
    logger.warn(
      { filename, sizeBytes: buffer.length },
      '[sidecar] File exceeds 80 MB cap — falling back to inline parser'
    )
    return null
  }

  const formData = new FormData()
  formData.append('file', new Blob([new Uint8Array(buffer)]), filename)

  const headers: Record<string, string> = authHeaders()
  if (orgId) headers['X-Org-Id'] = orgId

  try {
    const res = await fetchWithTimeout(`${getSidecarUrl()}/parse`, {
      method: 'POST',
      headers,
      body: formData,
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const data = (await res.json()) as ParseResult
    cbSuccess()
    logger.info(
      { parser_used: data.parser_used, duration_ms: data.duration_ms, file_size_bytes: data.file_size_bytes },
      '[sidecar] parse OK'
    )
    return data
  } catch (err) {
    cbFailure()
    logger.warn(
      { filename, err: err instanceof Error ? err.message : String(err) },
      '[sidecar] parse failed — falling back to inline parser'
    )
    return null
  }
}

/**
 * Chunk text semantically via the sidecar (Chonkie).
 * Returns null if the sidecar is unavailable.
 * Caller must treat null as a signal to fall through to the TS chunker.
 */
export async function chunkSemantic(
  text: string,
  targetTokens: number,
  overlapTokens = 0,
): Promise<ChunkResult | null> {
  if (!isConfigured()) return null
  if (!cbAvailable()) {
    logger.warn({}, '[sidecar] Circuit breaker open — skipping semantic chunk')
    return null
  }

  try {
    const res = await fetchWithTimeout(`${getSidecarUrl()}/chunk`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, target_tokens: targetTokens, overlap_tokens: overlapTokens }),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const data = (await res.json()) as ChunkResult
    cbSuccess()
    return data
  } catch (err) {
    cbFailure()
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[sidecar] chunk failed — falling back to TS chunker'
    )
    return null
  }
}

/** Exposed for tests and health-check routes. */
export function _circuitBreakerState(): Readonly<CBState> {
  return { ..._cb }
}

/** Reset the circuit breaker (test helper only). */
export function _resetCircuitBreaker(): void {
  _cb.state = 'closed'
  _cb.failures = 0
  _cb.openedAt = 0
}
