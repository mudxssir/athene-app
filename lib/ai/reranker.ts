import { logger } from "@/lib/logger";

const JINA_RERANKER_URL = "https://api.jina.ai/v1/rerank";

interface RerankResult {
  index: number;
  relevance_score: number;
}

/** Maximum characters per chunk sent to Jina (model token limit protection). */
const JINA_MAX_CHARS_PER_CHUNK = 2000;

/**
 * Extracts the best available text from a chunk for the cross-encoder.
 * Prefers `chunk_text` (full stored text, §4 P0-A) over `content_preview`
 * (200-char display snippet) — the cross-encoder scores on semantic content,
 * so a richer input produces better relevance ordering.
 * Caps at JINA_MAX_CHARS_PER_CHUNK to stay within Jina's token budget.
 */
function chunkScoringText(c: Record<string, unknown>): string {
  const full =
    (typeof c.chunk_text === "string" ? c.chunk_text.trim() : "") ||
    (typeof c.content_preview === "string" ? c.content_preview.trim() : "");
  return full.slice(0, JINA_MAX_CHARS_PER_CHUNK);
}

/**
 * Re-ranks chunks by relevance to the query using the Jina cross-encoder.
 * Falls back to the original order (capped at topN) if the API is unavailable
 * or JINA_API_KEY is not set.
 *
 * Cross-encoders score (query, chunk) jointly, producing significantly better
 * relevance ordering than cosine similarity alone — critical for BI queries
 * that pull large topK windows where tail chunks dilute synthesis quality.
 *
 * Chunks with no text are filtered before the API call so they don't consume
 * slots from the Jina top_n budget and silently displace real results.
 */
export async function rerankChunks<T extends { content_preview: string }>(
  query: string,
  chunks: T[],
  topN = 10
): Promise<(T & { rerank_score?: number })[]> {
  if (chunks.length === 0) return [];

  // Filter zero-text chunks before paying for API call or consuming topN slots.
  const textChunks = chunks.filter(
    (c) => chunkScoringText(c as unknown as Record<string, unknown>).length > 0
  );
  const zeroTextDropped = chunks.length - textChunks.length;
  if (zeroTextDropped > 0) {
    logger.warn(
      { zeroTextDropped, total: chunks.length },
      "[reranker] Dropped empty-text chunks before scoring — re-index affected documents"
    );
  }

  if (textChunks.length === 0) return [];
  if (textChunks.length <= topN) return textChunks;

  const jinaKey = process.env.JINA_API_KEY;
  if (!jinaKey) {
    logger.debug({}, "[reranker] JINA_API_KEY not set — using original order");
    return textChunks.slice(0, topN);
  }

  try {
    const response = await fetch(JINA_RERANKER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jinaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "jina-reranker-v2-base-multilingual",
        query,
        documents: textChunks.map((c) =>
          chunkScoringText(c as unknown as Record<string, unknown>)
        ),
        top_n: topN,
      }),
    });

    if (!response.ok) {
      throw new Error(`Jina reranker HTTP ${response.status}`);
    }

    const data = await response.json();
    const results = (data.results ?? []) as RerankResult[];

    return results
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((r) => ({ ...textChunks[r.index], rerank_score: r.relevance_score }));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[reranker] API failed — falling back to original order"
    );
    return textChunks.slice(0, topN);
  }
}
