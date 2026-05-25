import { Redis } from "@upstash/redis";
import { logger } from "@/lib/logger";
import { MemoryCache } from "./memory-cache";

// Graceful fallback: if Upstash env vars aren't set, use an in-memory cache
// so rate-limiting, caching, and counters all work correctly during local dev
// or in single-instance deployments without Upstash Redis.
// NOTE: MemoryCache is process-local — not shared across serverless instances.
// Use Upstash Redis for production multi-instance setups.
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

const isValidUrl = !!(url && url.startsWith("https://"));

export const redis =
  isValidUrl && token
    ? new Redis({ url, token })
    : (new MemoryCache() as unknown as Redis);

/**
 * Helper to cache a value in Redis.
 *
 * @param key - The unique Redis key
 * @param ttlSeconds - Time-to-live in seconds
 * @param fn - Async function to compute the value if it's missing in cache
 * @returns The cached or freshly computed value
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  try {
    const cachedValue = await redis.get<T>(key);
    if (cachedValue !== null) {
      return cachedValue;
    }
  } catch (error) {
    logger.warn({ key, err: error instanceof Error ? error.message : String(error) }, "[Redis] Error fetching key");
    // Proceed to fn() fallback if Redis fetch fails so the app doesn't crash
  }

  const result = await fn();

  try {
    await redis.set(key, result, { ex: ttlSeconds });
  } catch (error) {
    logger.warn({ key, err: error instanceof Error ? error.message : String(error) }, "[Redis] Error setting key");
  }

  return result;
}

/**
 * Increment a numerical counter by 1. If the counter did not exist,
 * it will be set to 1 and receive the specified expiration.
 *
 * ATOMICITY: INCR and EXPIRE are sent in a single pipeline batch (one HTTP
 * round-trip for Upstash REST), preventing the EXPIRE-never-called bug that
 * would occur if the process crashed between two separate calls.
 * EXPIRE is called unconditionally — this uses a "sliding window" semantics
 * where the TTL resets with each request. For the slot counter use-case this
 * is intentional (job window extends while actively running); for rate
 * limiters it keeps counters from leaking indefinitely.
 *
 * @param key - The strictly tracked key name
 * @param ttlSeconds - Time-to-live for the counter
 * @returns The new count, or null if Redis fails (fail-closed: aborts dispatch)
 */
export async function incrWithExpire(
  key: string,
  ttlSeconds: number
): Promise<number | null> {
  try {
    // Pipeline: both commands sent in one HTTP request — avoids EXPIRE being
    // dropped if the process crashes between a bare INCR and a bare EXPIRE.
    const pipe = redis.pipeline();
    pipe.incr(key);
    pipe.expire(key, ttlSeconds);
    const results = await pipe.exec<[number, number]>();
    const count = results[0];
    return count;
  } catch (error) {
    logger.error({ key, err: error instanceof Error ? error.message : String(error) }, "[Redis] Error incrementing key — dispatch will abort (fail-closed)");
    // Fail-Closed: Return null so dispatch aborts instead of flooding APIs
    return null;
  }
}

/**
 * High-level rate limiter using an incrementing counter.
 *
 * @param key - The unique identifier for the rate limit (e.g., user ID + endpoint)
 * @param limit - Maximum number of allowed requests in the window
 * @param windowSec - The duration of the rate limit window in seconds
 * @returns Object indicating if the request is allowed and how many remain
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number
): Promise<{ allowed: boolean; remaining: number }> {
  const count = await incrWithExpire(key, windowSec);

  if (count === null) {
    // Fail-open: If Redis is down, allow the request to prevent hard downtime
    return { allowed: true, remaining: limit };
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
  };
}
