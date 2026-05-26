"use server";

/**
 * RBAC Access Resolver
 * Resolves user roles and departmental access.
 * Caches results in Redis for performance.
 * Uses provided Clerk role as fallback if Supabase misses/fails.
 */

import { redis } from "@/lib/redis/client";
import { supabaseAdmin } from "@/lib/supabase/server";
import { mapRole } from "./clerk";
import { logger } from "@/lib/logger";
import { cache } from "react";


export type UserRole = "admin" | "super_user" | "member" | null;

export interface UserAccess {
  internal_user_id: string | null;
  internal_org_id: string | null;
  role: UserRole;
  dept_id: string | null;
  accessible_dept_ids: string[] | null;
  bi_grant_id: string | null;
}

const RBAC_CACHE_TTL_SECONDS = 300;

const USER_ACCESS_CACHE_PREFIX = "user_access";

function makeCacheKey(userId: string, orgId: string) {
  return `${USER_ACCESS_CACHE_PREFIX}:${userId}:${orgId}`;
}



/**
 * Resolves user access levels.
 * @param clerkRole Optional pre-resolved role from Clerk (e.g. from auth() in middleware)
 */
export const resolveUserAccess = cache(async (
  userId: string,
  orgId: string,
  clerkRole?: string | null
): Promise<UserAccess> => {
  const cacheKey = makeCacheKey(userId, orgId);

  try {
    const cached = await redis.get(cacheKey);
    if (typeof cached === "string") {
      logger.info({ userId, orgId }, "[rbac] Cache hit");
      return JSON.parse(cached) as UserAccess;
    }
  } catch (error) {
    logger.error({ userId, orgId, err: (error as Error).message }, "[rbac] Cache fetch failed");
  }


  let result: UserAccess | null = null;

  // 1. Try Supabase
  // Combine org lookup + member lookup into a single JOIN query (saves one DB round-trip).
  // org_members.org_id FK → organizations.id; PostgREST !inner filter on clerk_org_id.
  try {
    const { data: memberData, error: memberError } = await supabaseAdmin
      .from("org_members")
      .select("id, role, department_id, org_id, organizations!inner(id)")
      .eq("clerk_user_id", userId)
      .eq("organizations.clerk_org_id", orgId)
      .limit(1)
      .maybeSingle();

    if (memberError) {
      logger.warn({ userId, orgId, err: memberError.message }, "[rbac] Member+org query failed");
    }

    if (memberData) {
      const internalOrgId: string = (memberData as any).organizations?.id ?? memberData.org_id;

      // Fetch Grants — one remaining round-trip after we have org + member IDs
      const { data: grantData, error: grantError } = await supabaseAdmin
        .from("access_grants")
        .select("id, scope_type, scope_id, expires_at")
        .eq("user_id", memberData.id)
        .eq("org_id", internalOrgId);

      if (grantError) {
        logger.warn({ userId, orgId, err: grantError.message }, "[rbac] Grants query failed");
      }

      const grants = Array.isArray(grantData) ? grantData : [];
      const now = new Date();
      const activeGrants = grants.filter(
        (g) => !g.expires_at || new Date(g.expires_at) > now
      );

      const accessible_dept_ids = [...new Set(
        activeGrants
          .filter((g) => g.scope_type === "department")
          .map((g) => g.scope_id)
      )];

      result = {
        internal_user_id: memberData.id,
        internal_org_id: internalOrgId,
        role: memberData.role,
        dept_id: memberData.department_id ?? null,
        accessible_dept_ids: accessible_dept_ids.length ? accessible_dept_ids : null,
        bi_grant_id: activeGrants[0]?.id ?? null,
      };
    }
  } catch (dbError) {
    logger.error({ userId, orgId, err: (dbError as Error).message }, "[rbac] Supabase resolution fatal error");
  }


  // 2. Fallback: Auto-provision if missing (Issue #401 fix)
  if (!result || !result.internal_user_id) {
    if (orgId && userId) {
      try {
        // Lazy-sync Org
        let { data: orgData } = await supabaseAdmin
          .from("organizations")
          .select("id")
          .eq("clerk_org_id", orgId)
          .limit(1)
          .maybeSingle();

        if (!orgData) {
          // Use full Clerk ID in slug to avoid collisions on the UNIQUE constraint
          const slug = `org-${orgId.replace(/[^a-zA-Z0-9]/g, "").slice(-12).toLowerCase()}-${Date.now().toString(36)}`;
          const { data: newOrg, error: orgErr } = await supabaseAdmin
            .from("organizations")
            .insert({ clerk_org_id: orgId, name: "New Organization", slug })
            .select("id")
            .limit(1)
            .maybeSingle();

          if (orgErr) {
            // Slug collision or race condition — re-fetch in case another request created it
            logger.warn({ orgId, err: orgErr.message }, "[rbac] Org insert failed, re-fetching");
            const { data: retryOrg } = await supabaseAdmin
              .from("organizations")
              .select("id")
              .eq("clerk_org_id", orgId)
              .limit(1)
              .maybeSingle();
            orgData = retryOrg;
          } else {
            orgData = newOrg;
          }
        }

        if (!orgData) {
          logger.error({ orgId }, "[rbac] Failed to resolve or create organization");
          return { internal_user_id: null, internal_org_id: null, role: null, dept_id: null, accessible_dept_ids: null, bi_grant_id: null };
        }

        // Lazy-sync Member — try insert, fall back to select on conflict
        const mappedRole = mapRole(clerkRole || undefined) || "member";
        let memberData: { id: string; role: string } | null = null;

        const { data: newMember, error: memErr } = await supabaseAdmin
          .from("org_members")
          .insert({
            org_id: orgData.id,
            clerk_user_id: userId,
            email: `${userId}@placeholder.athene.ai`,
            role: mappedRole,
          })
          .select("id, role")
          .limit(1)
          .maybeSingle();

        if (memErr) {
          // UNIQUE (org_id, clerk_user_id) conflict — member already exists
          logger.warn({ userId, orgId, err: memErr.message }, "[rbac] Member insert failed, re-fetching");
          const { data: existing } = await supabaseAdmin
            .from("org_members")
            .select("id, role")
            .eq("clerk_user_id", userId)
            .eq("org_id", orgData.id)
            .limit(1)
            .maybeSingle();
          memberData = existing;
        } else {
          memberData = newMember;
        }

        if (!memberData) {
          logger.error({ userId, orgId }, "[rbac] Failed to resolve or create member");
          return { internal_user_id: null, internal_org_id: null, role: null, dept_id: null, accessible_dept_ids: null, bi_grant_id: null };
        }

        result = {
          internal_user_id: memberData.id,
          internal_org_id: orgData.id,
          role: memberData.role as UserRole,
          dept_id: null,
          accessible_dept_ids: null,
          bi_grant_id: null,
        };
      } catch (provisionErr) {
        logger.error({ userId, orgId, err: (provisionErr as Error).message }, "[rbac] Auto-provision failed");
      }
    }

    // If still no result after provisioning attempt, deny access
    if (!result || !result.internal_user_id) {
      result = {
        internal_user_id: null,
        internal_org_id: null,
        role: null,
        dept_id: null,
        accessible_dept_ids: null,
        bi_grant_id: null,
      };
    }
  }


  // 4. Cache
  try {
    await redis.set(cacheKey, JSON.stringify(result), { ex: RBAC_CACHE_TTL_SECONDS });
  } catch (err) {
    logger.error({ userId, orgId, err: (err as Error).message }, "[rbac] Cache write failed");
  }

  logger.info({ userId, orgId, role: result.role }, "[rbac] Resolution complete");

  return result;
});

/**
 * Manually invalidates the RBAC cache for a specific user/org pair.
 * Used by admin endpoints when roles or department assignments change.
 */
export async function invalidateRBACCache(userId: string, orgId: string): Promise<void> {
  try {
    await redis.del(makeCacheKey(userId, orgId));
    logger.info({ userId, orgId }, "[rbac] Cache invalidated");
  } catch (err) {
    logger.error({ userId, orgId, err: (err as Error).message }, "[rbac] Cache invalidation failed");
  }
}

/**
 * Asserts that a user has admin or super_user role within a specific organization.
 * Throws an error or returns a boolean depending on implementation.
 * For API routes, we'll return the role or null.
 */
export async function assertAdminRole(userId: string, orgId: string): Promise<UserRole | null> {
  // userId is the internal org_members.id (UUID) — set by middleware from access.internal_user_id.
  // Must query by primary key `id`, not `clerk_user_id`, to avoid identity mismatch.
  const { data: member, error } = await supabaseAdmin
    .from("org_members")
    .select("role")
    .eq("id", userId)
    .eq("org_id", orgId)
    .limit(1)
    .maybeSingle();

  if (error || !member) return null;
  
  const role = member.role as UserRole;
  if (role === "admin" || role === "super_user") {
    return role;
  }
  
  return null;
}
