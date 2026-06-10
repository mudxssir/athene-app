import { withRLS, type RLSContext } from "../supabase/rls-client";
import { embed } from "../ai/embedder";
import { withVectorSearchSpan } from "../telemetry/spans";
import { logger } from "@/lib/logger";

type UserRoleValue = "member" | "super_user" | "admin";

type Params = {
  orgId: string;
  userId: string;
  departmentId?: string | null;
  user_role: UserRoleValue;
  query: string;
  topK?: number;
  /**
   * Minimum cosine-similarity threshold (0.0–1.0). Results below this value
   * are excluded by the RPC. Defaults to 0.0 (no filter) — callers can raise
   * this to 0.3–0.5 when they want to suppress low-relevance noise.
   */
  minSimilarity?: number;
};

/**
 * Standard vector search for documents within the user's org and access context.
 */
export async function vectorSearch({
  orgId,
  userId,
  departmentId,
  user_role,
  query,
  topK = 5,
  minSimilarity = 0.0,
}: Params) {
  return withVectorSearchSpan(query, orgId, topK, async (span) => {
    // Pass orgId so BYOK embedding key is used — keeps index/query embedding spaces in sync
    const embedding = await embed(query, orgId);

    const ctx: RLSContext = {
      org_id: orgId,
      user_id: userId,
      department_id: departmentId ?? undefined,
      user_role,
    };

    const result = await withRLS(ctx, async (supabase) => {
      const { data, error } = await supabase.rpc("vector_search", {
        p_embedding: JSON.stringify(embedding),
        p_limit: topK,
        p_min_similarity: minSimilarity,
      });

      if (error) {
        logger.error({ error: error.message, orgId, userId, departmentId }, "[vector-search] RPC error");
        throw new Error(`[vector-search] ${error.message}`);
      }

      const rows = data ?? [];

      if (rows.length === 0) {
        logger.warn(
          { orgId, userId, departmentId, user_role, topK, minSimilarity },
          "[vector-search] 0 results — org may have no indexed content, or min_similarity threshold is too high"
        );
      } else {
        // Warn when results lack chunk_text (old-indexed docs pre-zero-copy design).
        const emptyText = rows.filter(
          (r: any) => !r.chunk_text?.trim() && !r.content_preview?.trim()
        ).length;
        if (emptyText > 0) {
          logger.warn(
            { orgId, emptyText, total: rows.length },
            "[vector-search] Some chunks have no text — re-index affected documents to populate chunk_text"
          );
        }
        logger.info({ orgId, resultsCount: rows.length }, "[vector-search] Retrieved chunks");
      }

      return rows;
    });

    span.setAttribute("vector.results_count", result.length);
    return result;
  });
}

/**
 * Cross-department vector search for BI Analysts (super_user) and admins.
 *
 * Role guard rationale:
 *   - super_user (org:bi_analyst) — primary audience for cross-dept analysis
 *   - admin — org administrators can view cross-dept data by design
 *   - member — blocked: no cross-org visibility grant
 *
 * The check fires BEFORE embed() and any DB query so that unauthorised
 * callers never trigger an embedding API call (plan item 4B.6).
 */
export async function crossDeptVectorSearch(params: Params) {
  if (params.user_role !== "super_user" && params.user_role !== "admin") {
    throw new Error("Unauthorized: cross-department search requires super_user or admin role");
  }

  const topK = params.topK ?? 5;
  const minSimilarity = params.minSimilarity ?? 0.0;

  return withVectorSearchSpan(params.query, params.orgId, topK, async (span) => {
    span.setAttribute("vector.cross_dept", true);
    // Pass orgId so BYOK embedding key is used — keeps index/query embedding spaces in sync
    const embedding = await embed(params.query, params.orgId);

    const ctx: RLSContext = {
      org_id: params.orgId,
      user_id: params.userId,
      department_id: params.departmentId ?? undefined,
      user_role: params.user_role,
    };

    const result = await withRLS(ctx, async (supabase) => {
      const { data, error } = await supabase.rpc("vector_search_cross_dept", {
        p_embedding: JSON.stringify(embedding),
        p_limit: topK,
        p_min_similarity: minSimilarity,
      });

      if (error) throw new Error(`[vector-search] ${error.message}`);

      const rows = data ?? [];
      if (rows.length === 0) {
        logger.warn(
          { orgId: params.orgId, topK, minSimilarity },
          "[vector-search/cross-dept] 0 results"
        );
      }
      return rows;
    });
    span.setAttribute("vector.results_count", result.length);
    return result;
  });
}
