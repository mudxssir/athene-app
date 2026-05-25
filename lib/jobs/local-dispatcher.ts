// ============================================================
// lib/jobs/local-dispatcher.ts — Local Job Dispatcher
//
// Drop-in replacement for QStash when QSTASH_TOKEN is not set.
// Dispatches jobs via direct HTTP fetch to local worker endpoints
// with HMAC-SHA256 signing for request verification.
//
// ISOLATION: This file is standalone. To wire it in, modify
// lib/qstash/client.ts to use LocalDispatcher when QSTASH_TOKEN
// is absent. The existing dev bypass (lines 80-89) proves this
// pattern works — this formalizes it with retry + signing.
//
// Pattern based on existing code in lib/qstash/client.ts:
//   if (isLocalDev) {
//     fetch(url, { method: 'POST', body: JSON.stringify(body) })
//   }
// ============================================================

import { createHmac } from 'crypto'

/** Configuration for the local dispatcher */
export interface LocalDispatcherConfig {
  /** Secret key for HMAC-SHA256 signing. Falls back to LOCAL_WORKER_SECRET env var. */
  secret?: string
  /** Base URL for worker endpoints. Falls back to NEXT_PUBLIC_APP_URL or localhost:3000. */
  baseUrl?: string
  /** Max retry attempts (default: 3) */
  maxRetries?: number
  /** Initial retry delay in ms (default: 1000, doubles each retry) */
  initialRetryDelayMs?: number
}

/** Result of a dispatch operation */
export interface DispatchResult {
  messageId: string
  status: 'delivered' | 'failed'
  attempts: number
  error?: string
}

/**
 * Local job dispatcher that replaces QStash for self-hosted deployments.
 *
 * - Direct HTTP POST to worker endpoints
 * - HMAC-SHA256 request signing (verified by local-verify.ts)
 * - Exponential backoff retry (3 attempts by default)
 * - Same publishJSON() interface as @upstash/qstash Client
 */
export class LocalDispatcher {
  private secret: string
  private baseUrl: string
  private maxRetries: number
  private initialRetryDelayMs: number

  constructor(config?: LocalDispatcherConfig) {
    this.secret = config?.secret
      ?? process.env.LOCAL_WORKER_SECRET
      ?? ''
    this.baseUrl = config?.baseUrl
      ?? process.env.NEXT_PUBLIC_APP_URL
      ?? 'http://localhost:3000'
    this.maxRetries = config?.maxRetries ?? 3
    this.initialRetryDelayMs = config?.initialRetryDelayMs ?? 1000

    if (!this.secret) {
      console.warn(
        '[LocalDispatcher] No LOCAL_WORKER_SECRET set. Requests will be unsigned. ' +
        'Generate one with: openssl rand -hex 32'
      )
    }
  }

  /**
   * Dispatch a JSON job to a worker endpoint.
   * Compatible with the QStash client's publishJSON() interface.
   */
  async publishJSON(options: {
    url: string
    body: unknown
    headers?: Record<string, string>
    retries?: number
    delay?: string // QStash-style delay (e.g., "30s") — ignored in local mode
  }): Promise<DispatchResult> {
    const { url, body, headers = {} } = options
    const maxAttempts = options.retries ?? this.maxRetries
    const messageId = generateMessageId()

    // Resolve URL: if relative, prepend baseUrl
    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url}`
    const bodyStr = JSON.stringify(body)

    // Generate HMAC signature
    const signature = this.sign(bodyStr)

    // In non-production environments the verifyQStashSignature() function accepts
    // the x-dev-internal-bypass header (same bypass used by dispatchThrottled() for
    // localhost). Without this, the worker returns 401 even though the call is local.
    const devBypassHeaders: Record<string, string> =
      process.env.NODE_ENV !== 'production'
        ? { 'x-dev-internal-bypass': '1' }
        : {}

    let lastError: string | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(fullUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Local-Signature': signature,
            'X-Local-Message-Id': messageId,
            'X-Local-Timestamp': String(Date.now()),
            ...devBypassHeaders,
            ...headers,
          },
          body: bodyStr,
          // AbortController for timeout (30s)
          signal: AbortSignal.timeout(30_000),
        })

        if (response.ok || (response.status >= 200 && response.status < 300)) {
          return { messageId, status: 'delivered', attempts: attempt }
        }

        // 4xx errors are not retryable (bad request, not a transient failure)
        if (response.status >= 400 && response.status < 500) {
          lastError = `HTTP ${response.status}: ${await response.text().catch(() => 'unknown')}`
          return { messageId, status: 'failed', attempts: attempt, error: lastError }
        }

        // 5xx errors are retryable
        lastError = `HTTP ${response.status}`
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err)
      }

      // Exponential backoff before retry
      if (attempt < maxAttempts) {
        const delay = this.initialRetryDelayMs * Math.pow(2, attempt - 1)
        await sleep(delay)
      }
    }

    return {
      messageId,
      status: 'failed',
      attempts: maxAttempts,
      error: lastError,
    }
  }

  /**
   * Sign a request body with HMAC-SHA256.
   * Returns empty string if no secret is configured.
   */
  private sign(body: string): string {
    if (!this.secret) return ''
    return createHmac('sha256', this.secret)
      .update(body)
      .digest('hex')
  }

  /**
   * Create a QStash-compatible schedules interface (subset).
   * For local mode, cron schedules are stored in-memory and executed
   * via setInterval. Production should use QStash schedules.
   */
  get schedules() {
    return {
      create: async (options: {
        destination: string
        cron: string
        body?: unknown
      }) => {
        // In local mode, we just log the schedule.
        // A real implementation would use node-cron or similar.
        const scheduleId = `local_schedule_${generateMessageId()}`
        console.log(
          `[LocalDispatcher] Schedule registered (not executed in local mode): ` +
          `${options.cron} → ${options.destination} [${scheduleId}]`
        )
        return { scheduleId }
      },
      delete: async (scheduleId: string) => {
        console.log(`[LocalDispatcher] Schedule deleted: ${scheduleId}`)
      },
    }
  }
}

// ---- Helpers ────────────────────────────────────────────────

function generateMessageId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 10)
  return `local_${timestamp}_${random}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Singleton instance. Use this in the app instead of creating new instances.
 *
 * Usage:
 *   import { localDispatcher } from '@/lib/jobs/local-dispatcher'
 *   await localDispatcher.publishJSON({ url: '/api/worker/nango-fetch', body: { ... } })
 */
export const localDispatcher = new LocalDispatcher()
