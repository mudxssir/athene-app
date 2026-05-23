import { Receiver } from '@upstash/qstash';
import { redis } from '@/lib/redis/client';
import { logger } from '@/lib/logger';

const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

// Build receiver lazily — only when both keys are present.
// Top-level throws would crash any route that imports this module.
const receiver =
  currentSigningKey && nextSigningKey
    ? new Receiver({ currentSigningKey, nextSigningKey })
    : null;

/**
 * Validates the Upstash signature of an incoming webhook request.
 *
 * In local dev (no signing keys configured), a request carrying the
 * `x-dev-internal-bypass` header is accepted so that the briefing
 * route can invoke the worker directly without QStash.
 *
 * MUST be called before fulfilling any background job worker request.
 */
export async function verifyQStashSignature(req: Request): Promise<boolean> {
  // ── Dev bypass: allow direct localhost calls even when signing keys are present ──
  // dispatchThrottled sets x-dev-internal-bypass when NEXT_PUBLIC_APP_URL is localhost.
  // This lets the dev server call workers directly without going through QStash.
  if (process.env.NODE_ENV !== 'production') {
    const bypass = req.headers.get('x-dev-internal-bypass');
    if (bypass === '1') {
      logger.warn({}, '[QStash] Accepting x-dev-internal-bypass (local dev only)');
      return true;
    }
  }

  // ── No receiver: signing keys absent ──
  if (!receiver) {
    if (process.env.NODE_ENV === 'production') {
      logger.error({}, '[QStash] Signature verification skipped in production: QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY not set');
      return false;
    }
    logger.error({}, '[QStash] Signature verification skipped: QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY not set');
    return false;
  }

  try {
    const signature = req.headers.get('upstash-signature');
    if (!signature) {
      return false;
    }

    // We clone the request so that consuming its raw text doesn't
    // prevent the downstream route logic from parsing JSON later.
    const body = await req.clone().text();

    // QStash signs the JWT `sub` field with the public URL it was told to call
    // (e.g. https://xxx.trycloudflare.com/api/worker/nango-fetch). When the
    // request arrives at the Next.js server it has req.url = http://localhost:3000/...
    // which doesn't match the signed subject and verification fails.
    // Fix: reconstruct the public URL from NEXT_PUBLIC_APP_URL so the subject matches.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    const verifyUrl = appUrl
      ? appUrl.replace(/\/$/, '') + new URL(req.url).pathname
      : req.url;

    const isValid = await receiver.verify({
      signature,
      body,
      url: verifyUrl,
    });

    return isValid;
  } catch (err: any) {
    logger.error({ err: err?.message }, '[QStash] Signature verification failed');
    return false;
  }
}

/**
 * Checks if a QStash message has already been processed using Redis.
 * Returns true if this is the first time we see this message, false otherwise.
 * 
 * TTL: 24 hours (prevents infinite growth while covering standard retry windows)
 */
export async function checkIdempotency(req: Request): Promise<boolean> {
  try {
    const msgId = req.headers.get('upstash-message-id');
    if (!msgId) {
      // If there's no message ID, we can't reliably dedup. 
      // In production workers, this header should always be present from QStash.
      return true;
    }

    const key = `qstash_job:${msgId}`;
    // NX: Set only if the key does not exist.
    // EX: Set expiration to 24 hours.
    const result = await redis.set(key, '1', { nx: true, ex: 86400 });

    return result === 'OK';
  } catch (err: any) {
    logger.error({ err: err?.message }, '[QStash] Idempotency check failed (Redis error)');
    // Fail-open: if Redis is down, we allow the request but risk double-processing
    // rather than blocking all background work.
    return true;
  }
}
