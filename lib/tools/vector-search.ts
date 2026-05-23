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
      });

      if (error) {
        logger.error({ error: error.message, orgId, userId, departmentId }, "[vector-search] RPC error");
        throw new Error(`[vector-search] ${error.message}`);
      }
      
      if (!data || data.length === 0) {
        logger.warn({ orgId, userId, departmentId, user_role, topK }, "[vector-search] Returned 0 results for query");
      } else {
        logger.info({ orgId, resultsCount: data.length }, "[vector-search] Retrieved chunks successfully");
      }
      
      return data ?? [];
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
      });

      if (error) throw new Error(`[vector-search] ${error.message}`);
      return data ?? [];
    });
    span.setAttribute("vector.results_count", result.length);
    return result;
  });
}
