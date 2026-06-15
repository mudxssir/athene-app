import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { MemorySaver } from "@langchain/langgraph";
import { logger } from "@/lib/logger";

let checkpointerInstance: PostgresSaver | MemorySaver | null = null;
let usingMemory = false;

/**
 * Returns a lazily-initialized checkpointer.
 *
 * Reads SUPABASE_DB_URL or DATABASE_URL. Appends sslmode=require for
 * Supabase connections that omit it, so Vercel → Supabase works without
 * extra env config.
 *
 * Pool is capped at 2 connections — safe for Vercel serverless where each
 * warm instance shares the pool across concurrent requests.
 *
 * Resets and retries on each cold start if the previous attempt failed,
 * rather than caching a broken MemorySaver forever.
 */
export async function getCheckpointer(): Promise<PostgresSaver | MemorySaver> {
  if (checkpointerInstance) return checkpointerInstance;

  const raw = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;

  if (!raw) {
    logger.warn({}, "[checkpointer] No DB connection string found (SUPABASE_DB_URL / DATABASE_URL). Falling back to MemorySaver — conversation history will not persist across cold starts.");
    usingMemory = true;
    checkpointerInstance = new MemorySaver();
    return checkpointerInstance;
  }

  // Ensure SSL for Supabase pooler connections
  const connectionString = ensureSsl(raw);

  // Strict TLS first; on a self-signed / untrusted-CA failure (common with the
  // Supabase pooler cert and behind corporate TLS-inspection proxies), retry once
  // with cert verification relaxed. The connection stays encrypted — only CA
  // verification is skipped — and persistence (multi-turn memory) is preserved
  // instead of silently degrading to per-request MemorySaver. Default is strict.
  const attempts: Array<Record<string, unknown>> = [
    { max: 2 },
    { max: 2, ssl: { rejectUnauthorized: false } },
  ];

  let lastErr: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const saver = PostgresSaver.fromConnString(connectionString, attempts[i] as any);
      await saver.setup();
      checkpointerInstance = saver;
      usingMemory = false;
      logger.info(
        { relaxedTls: i > 0 },
        i > 0
          ? "[checkpointer] PostgresSaver initialized with relaxed TLS (untrusted CA) — persistence enabled."
          : "[checkpointer] PostgresSaver initialized."
      );
      return saver;
    } catch (err) {
      lastErr = err;
      const isCertError = /self-signed|certificate|unable to verify|SELF_SIGNED/i.test(String(err));
      // Only escalate to the relaxed-TLS attempt for cert-class errors.
      if (i === 0 && !isCertError) break;
    }
  }

  // Do NOT cache the MemorySaver — allows retry on the next request rather
  // than permanently degrading all subsequent requests to in-memory storage.
  logger.error(
    { err: lastErr instanceof Error ? lastErr.message : String(lastErr) },
    "[checkpointer] Failed to initialize PostgresSaver, falling back to MemorySaver for this request only"
  );
  usingMemory = false; // Keep false so next request retries the DB
  return new MemorySaver();
}

/** Returns true if the active checkpointer is in-memory (non-persistent). */
export function isMemoryCheckpointer(): boolean {
  return usingMemory;
}

function ensureSsl(url: string): string {
  if (url.includes("sslmode=") || url.startsWith("postgresql://localhost") || url.startsWith("postgres://localhost")) {
    return url;
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}sslmode=require`;
}
