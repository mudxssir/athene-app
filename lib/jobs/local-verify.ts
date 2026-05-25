// ============================================================
// lib/jobs/local-verify.ts — Local Request Signature Verification
//
// Verifies HMAC-SHA256 signatures on worker requests dispatched
// by LocalDispatcher. Drop-in replacement for verifyQStashSignature()
// when running without QStash.
//
// ISOLATION: This file is standalone. To wire it in, modify
// lib/qstash/verify.ts to check LOCAL_WORKER_SECRET when QStash
// signing keys are absent:
//
//   import { verifyLocalSignature } from '@/lib/jobs/local-verify'
//   export async function verifyQStashSignature(req: Request) {
//     if (qstashSigningKeys) return verifyQStash(req)
//     if (process.env.LOCAL_WORKER_SECRET) return verifyLocalSignature(req)
//     return isDev // current fallback
//   }
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Verify a request was signed by the local dispatcher.
 *
 * Checks the X-Local-Signature header against an HMAC-SHA256 of the
 * request body using LOCAL_WORKER_SECRET. Uses timing-safe comparison
 * to prevent timing attacks.
 *
 * @param request - The incoming Request object
 * @param secret - Override secret (defaults to LOCAL_WORKER_SECRET env var)
 * @returns true if signature is valid, false otherwise
 */
export async function verifyLocalSignature(
  request: Request,
  secret?: string,
): Promise<boolean> {
  const signingSecret = secret ?? process.env.LOCAL_WORKER_SECRET

  // No secret configured — reject in production, allow in dev
  if (!signingSecret) {
    const isDev = process.env.NODE_ENV === 'development'
      || process.env.NODE_ENV === 'test'
    if (isDev) {
      console.warn('[local-verify] No LOCAL_WORKER_SECRET — allowing request in dev mode')
      return true
    }
    console.error('[local-verify] No LOCAL_WORKER_SECRET set. Rejecting unsigned request.')
    return false
  }

  // Extract signature from header
  const providedSignature = request.headers.get('x-local-signature')
  if (!providedSignature) {
    console.error('[local-verify] Missing X-Local-Signature header')
    return false
  }

  // Read and verify body
  let body: string
  try {
    body = await request.clone().text()
  } catch {
    console.error('[local-verify] Failed to read request body')
    return false
  }

  // Compute expected signature
  const expectedSignature = createHmac('sha256', signingSecret)
    .update(body)
    .digest('hex')

  // Timing-safe comparison (prevents timing attacks)
  try {
    const providedBuf = Buffer.from(providedSignature, 'hex')
    const expectedBuf = Buffer.from(expectedSignature, 'hex')

    if (providedBuf.length !== expectedBuf.length) {
      return false
    }

    return timingSafeEqual(providedBuf, expectedBuf)
  } catch {
    // Invalid hex encoding or other comparison errors
    return false
  }
}

/**
 * Verify request and extract the message ID for idempotency.
 *
 * @param request - The incoming Request object
 * @returns Object with isValid flag and messageId (if present)
 */
export async function verifyAndExtractId(
  request: Request,
  secret?: string,
): Promise<{ isValid: boolean; messageId: string | null }> {
  const isValid = await verifyLocalSignature(request, secret)
  const messageId = request.headers.get('x-local-message-id')
  return { isValid, messageId }
}

/**
 * Check request freshness using the X-Local-Timestamp header.
 * Rejects requests older than the specified max age (default: 5 minutes).
 *
 * @param request - The incoming Request object
 * @param maxAgeMs - Maximum age in milliseconds (default: 300000 = 5 min)
 * @returns true if the request is fresh enough
 */
export function isRequestFresh(
  request: Request,
  maxAgeMs: number = 5 * 60 * 1000,
): boolean {
  const timestampHeader = request.headers.get('x-local-timestamp')

  if (!timestampHeader) {
    // LocalDispatcher always sets X-Local-Timestamp. A missing header means the
    // request did not come from the dispatcher (e.g. a replay attack stripping
    // headers, or a misconfigured proxy). Reject in production; allow in dev to
    // not block manual curl testing.
    const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
    if (!isDev) {
      console.error('[local-verify] Missing X-Local-Timestamp — rejecting as potentially replayed')
      return false
    }
    return true
  }

  const timestamp = parseInt(timestampHeader, 10)
  if (isNaN(timestamp)) return false

  const age = Date.now() - timestamp
  return age >= 0 && age <= maxAgeMs
}
