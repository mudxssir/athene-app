// ============================================================
// lib/redis/memory-cache.ts — In-Memory Redis Replacement
//
// Drop-in replacement for Upstash Redis when UPSTASH_REDIS_REST_URL
// is not set. Provides a real in-memory cache with TTL support
// instead of the no-op stub in client.ts.
//
// ISOLATION: This file is standalone. To wire it in, replace the
// no-op stub in lib/redis/client.ts with:
//   import { MemoryCache } from './memory-cache'
//   export const redis = isValidUrl && token
//     ? new Redis({ url, token })
//     : new MemoryCache() as unknown as Redis;
//
// LIMITATION: Single-process only. In serverless/multi-instance
// deployments, each instance has its own cache. Use Upstash Redis
// for production multi-instance setups.
// ============================================================

interface CacheEntry {
  value: unknown
  expiry: number | null // null = no expiration (lives forever)
}

interface PipelineCommand {
  method: string
  args: unknown[]
}

/**
 * In-memory cache that implements the subset of the Upstash Redis
 * interface used by the Athene app (get, set, incr, decr, expire, del, pipeline).
 */
// Maximum number of cache entries before the oldest entry is evicted (LRU-lite).
// Prevents unbounded growth in long-running processes with many unique keys.
const MAX_CACHE_SIZE = 10_000

export class MemoryCache {
  private store = new Map<string, CacheEntry>()
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    // Purge expired entries every 60 seconds
    this.cleanupInterval = setInterval(() => this.purgeExpired(), 60_000)
    // Allow Node to exit even if the interval is active
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref()
    }
  }

  /** Remove all entries whose TTL has passed */
  private purgeExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (entry.expiry !== null && entry.expiry <= now) {
        this.store.delete(key)
      }
    }
  }

  /** Check if a key is expired (and delete it if so) */
  private isExpired(key: string): boolean {
    const entry = this.store.get(key)
    if (!entry) return true
    if (entry.expiry !== null && entry.expiry <= Date.now()) {
      this.store.delete(key)
      return true
    }
    return false
  }

  // ── Core Redis-compatible methods ────────────────────────────

  async get<T = unknown>(key: string): Promise<T | null> {
    if (this.isExpired(key)) return null
    const entry = this.store.get(key)
    if (!entry) return null
    return entry.value as T
  }

  async set(
    key: string,
    value: unknown,
    options?: { ex?: number; px?: number; nx?: boolean; xx?: boolean }
  ): Promise<string | null> {
    // NX: only set if key does NOT exist
    if (options?.nx && this.store.has(key) && !this.isExpired(key)) {
      return null
    }
    // XX: only set if key DOES exist
    if (options?.xx && (this.isExpired(key) || !this.store.has(key))) {
      return null
    }

    let expiry: number | null = null
    if (options?.ex) {
      expiry = Date.now() + options.ex * 1000
    } else if (options?.px) {
      expiry = Date.now() + options.px
    }

    // Evict the oldest entry when at capacity (Map preserves insertion order)
    if (this.store.size >= MAX_CACHE_SIZE) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }

    this.store.set(key, { value, expiry })
    return 'OK'
  }

  async incr(key: string): Promise<number> {
    if (this.isExpired(key)) {
      // Key doesn't exist — create with value 1, no expiry
      this.store.set(key, { value: 1, expiry: null })
      return 1
    }
    const entry = this.store.get(key)!
    const current = typeof entry.value === 'number' ? entry.value : parseInt(String(entry.value), 10) || 0
    const next = current + 1
    entry.value = next
    return next
  }

  async decr(key: string): Promise<number> {
    if (this.isExpired(key)) {
      this.store.set(key, { value: -1, expiry: null })
      return -1
    }
    const entry = this.store.get(key)!
    const current = typeof entry.value === 'number' ? entry.value : parseInt(String(entry.value), 10) || 0
    const next = current - 1
    entry.value = next
    return next
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    if (this.isExpired(key)) return false
    const entry = this.store.get(key)
    if (!entry) return false
    entry.expiry = Date.now() + seconds * 1000
    return true
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.store.delete(key)) deleted++
    }
    return deleted
  }

  /**
   * Pipeline: batches commands and returns results in order.
   * In-memory implementation executes sequentially (no network batching needed).
   */
  pipeline(): MemoryPipeline {
    return new MemoryPipeline(this)
  }

  // ── Cleanup ──────────────────────────────────────────────────

  /** Stop the background cleanup interval (for tests / graceful shutdown) */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.store.clear()
  }

  /** Current number of entries (including potentially expired ones) */
  get size(): number {
    return this.store.size
  }
}

/**
 * Pipeline that collects commands and executes them sequentially.
 * Mimics Upstash Redis pipeline interface.
 */
class MemoryPipeline {
  private commands: PipelineCommand[] = []
  private cache: MemoryCache

  constructor(cache: MemoryCache) {
    this.cache = cache
  }

  incr(key: string): this {
    this.commands.push({ method: 'incr', args: [key] })
    return this
  }

  expire(key: string, seconds: number): this {
    this.commands.push({ method: 'expire', args: [key, seconds] })
    return this
  }

  set(key: string, value: unknown, options?: Record<string, unknown>): this {
    this.commands.push({ method: 'set', args: [key, value, options] })
    return this
  }

  get(key: string): this {
    this.commands.push({ method: 'get', args: [key] })
    return this
  }

  del(...keys: string[]): this {
    this.commands.push({ method: 'del', args: keys })
    return this
  }

  decr(key: string): this {
    this.commands.push({ method: 'decr', args: [key] })
    return this
  }

  async exec<T = unknown[]>(): Promise<T> {
    const results: unknown[] = []
    for (const cmd of this.commands) {
      const method = (this.cache as any)[cmd.method]
      if (typeof method === 'function') {
        const result = await method.apply(this.cache, cmd.args)
        results.push(result)
      } else {
        results.push(null)
      }
    }
    return results as T
  }
}
