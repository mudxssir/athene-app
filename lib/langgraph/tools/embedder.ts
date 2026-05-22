// ============================================================
// embedder.ts — Google batch embeddings
//
// Uses text-embedding-004 (768-dim) to match the vector(768)
// column on document_embeddings (migrated in 20260514000001).
//
// Rule #2: input texts are passed through to Google and the
// vectors come back. Nothing here writes text to Supabase.
// ============================================================

import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSIONS = 768;

// Google batchEmbedContents supports up to 100 inputs per call.
// 96 keeps us safely under that limit.
const DEFAULT_BATCH_SIZE = 96;

let googleInstance: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!googleInstance) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("Missing GOOGLE_API_KEY environment variable");
    }
    googleInstance = new GoogleGenerativeAI(apiKey);
  }
  return googleInstance;
}

/**
 * Embed an array of texts. Preserves input order.
 *
 * Returns an array of 768-dim vectors. Batches requests of more
 * than DEFAULT_BATCH_SIZE items to stay under the Google limit.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const genAI = getClient();
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const results: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += DEFAULT_BATCH_SIZE) {
    const slice = texts.slice(i, i + DEFAULT_BATCH_SIZE);
    const res = await model.batchEmbedContents({
      requests: slice.map((text) => ({
        content: { parts: [{ text }], role: "user" },
        taskType: TaskType.RETRIEVAL_DOCUMENT,
      })),
    });

    res.embeddings.forEach((emb, j) => {
      results[i + j] = emb.values;
    });
  }

  return results;
}

export const EMBEDDING_CONFIG = {
  model: EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
} as const;
