import { withRLS, type RLSContext } from "./rls-client";
import { logger } from "@/lib/logger";
import { CHUNK_TEXT_ENCRYPTION } from "@/lib/config/feature-flags";
import { decryptChunkText, isEncrypted } from "@/lib/indexing/chunk-crypto";

export type SearchResult = {
  id: string;
  document_id: string;
  content_preview: string;
  metadata: Record<string, unknown>;
  similarity: number;
};

/**
 * Performs a vector similarity search within the RLS-protected context.
 * Uses withRLS() so Postgres session vars are set and grants are injected.
 */
export async function similaritySearch(
  context: RLSContext,
  queryEmbedding: number[],
  matchThreshold: number = 0.5,
  matchCount: number = 10
): Promise<SearchResult[]> {
  return withRLS(context, async (supabase) => {
    const { data, error } = await supabase.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (error) {
      logger.error({ err: error?.message ?? String(error) }, "[vector] similaritySearch error");
      throw error;
    }

    const rows = (data as SearchResult[]) || [];

    // P7: the RPC returns the raw (possibly encrypted) metadata value; decrypt
    // chunk_text app-side at this single retrieval boundary so all downstream
    // consumers see plaintext. No-op when encryption is off.
    if (CHUNK_TEXT_ENCRYPTION) {
      for (const r of rows) {
        const ct = (r.metadata as Record<string, unknown> | null | undefined)?.chunk_text;
        if (typeof ct === "string" && isEncrypted(ct)) {
          (r.metadata as Record<string, unknown>).chunk_text = decryptChunkText(ct, context.org_id) ?? "";
        }
      }
    }
    return rows;
  });
}
