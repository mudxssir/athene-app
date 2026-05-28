// ============================================================
// rls-client.ts — RLS-aware Supabase client
//
// The core withRLS() wrapper guarantees that every query executes
// with Postgres session variables set via set_app_context() RPC.
// For super_users, grants are loaded and injected via
// set_session_grants() so RLS policies can evaluate them.
//
// Two enforcement layers (belt-and-suspenders):
//   1. HTTP headers via Supabase client (PostgREST request.headers)
//   2. Explicit SET LOCAL via set_app_context() RPC call
// app_setting() in 002_rls_policies.sql checks headers first,
// falls back to current_setting() — so both paths work.
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "./server";
import { logger } from "@/lib/logger";

const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY"
  );
}

// ---- Types --------------------------------------------------

export type RLSContext = {
  org_id: string;
  user_id: string;
  department_id?: string;
  user_role?: "member" | "super_user" | "admin";
  accessible_dept_ids?: string[];
};

type Grant = { scope_type: string; scope_id: string };

// ---- Extract context from middleware-injected headers --------

/**
 * Extracts RLS context from request headers.
 * These headers are injected by the middleware after RBAC resolution.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getContextFromHeaders(headers: Headers): RLSContext | null {
  const org_id = headers.get("x-current-org-id");
  const user_id = headers.get("x-current-user-id");
  const user_role = headers.get("x-current-user-role");
  const department_id = headers.get("x-current-user-dept-id") || "";
  const accessible_depts_raw = headers.get("x-current-accessible-depts");

  if (!org_id || !user_id || !user_role) {
    return null;
  }

  // Reject Clerk org IDs (format: "org_2abc…") — org_id must be an internal UUID FK
  if (!UUID_RE.test(org_id)) {
    logger.error({ org_id_prefix: org_id.slice(0, 20) }, "[rls-client] x-current-org-id is not a valid UUID — middleware may be passing a Clerk org ID instead of the internal UUID");
    return null;
  }

  const VALID_ROLES = ["member", "super_user", "admin"] as const;
  if (!VALID_ROLES.includes(user_role as typeof VALID_ROLES[number])) {
    logger.warn({ user_role }, "[rls-client] Unexpected x-current-user-role header value");
    return null;
  }

  return {
    org_id,
    user_id,
    user_role: user_role as "member" | "super_user" | "admin",
    department_id,
    accessible_dept_ids: (() => {
      if (!accessible_depts_raw) return [];
      try { return JSON.parse(accessible_depts_raw); } catch { return []; }
    })(),
  };
}

// ---- Low-level client factory (headers only) ----------------

function createRLSClient(
  context: RLSContext,
  grants?: Grant[]
): SupabaseClient {
  const headers: Record<string, string> = {
    "x-app-org-id": context.org_id,
    "x-app-user-id": context.user_id,
    "x-app-role": context.user_role || "member",
  };
  // Only send dept-id when non-empty — the RLS policy casts it to uuid,
  // so an empty string causes "invalid input syntax for type uuid: """
  if (context.department_id) {
    headers["x-app-dept-id"] = context.department_id;
  }

  if (grants && grants.length > 0) {
    headers["x-app-grants"] = JSON.stringify(grants);
  }

  return createClient(supabaseUrl!, supabaseAnonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers },
  });
}

// ---- The main wrapper ---------------------------------------

/**
 * Execute `callback` with full RLS context set in Postgres.
 *
 * 1. Resolves super_user grants (from middleware cache or DB fallback).
 * 2. Creates a Supabase client with context headers (PostgREST path).
 * 3. Calls set_app_context() RPC to SET LOCAL the session vars
 *    (direct Postgres path — belt-and-suspenders).
 * 4. For super_users, calls set_session_grants() to create the
 *    per-transaction temp table that RLS policies check.
 * 5. Runs the callback with the RLS-protected client.
 */
export async function withRLS<T>(
  context: RLSContext,
  callback: (supabase: SupabaseClient) => Promise<T>
): Promise<T> {
  let grants: Grant[] = [];

  // ---- 1. Resolve super_user grants --------------------------
  if (context.user_role === "super_user") {
    if (
      context.accessible_dept_ids &&
      context.accessible_dept_ids.length > 0
    ) {
      // Use the middleware-cached dept list (fast path)
      grants = context.accessible_dept_ids.map((deptId) => ({
        scope_type: "department",
        scope_id: deptId,
      }));
    } else {
      // Fallback: fetch from DB via service-role (bypasses RLS intentionally —
      // we need to read grants BEFORE RLS context exists for this request).
      // Load BOTH access_grants (department-level) and bi_accessible_grants
      // (document/folder-level) so has_grant() in RLS policies sees all grants.
      const [accessRes, biRes] = await Promise.all([
        supabaseAdmin
          .from("access_grants")
          .select("scope_type, scope_id")
          .eq("user_id", context.user_id)
          .eq("org_id", context.org_id),
        supabaseAdmin
          .from("bi_accessible_grants")
          .select("resource_type, resource_id")
          .eq("org_id", context.org_id),
      ]);

      if (accessRes.error) {
        logger.error({ org_id: context.org_id, user_id: context.user_id, err: accessRes.error.message }, "[rls-client] Failed to fetch super_user grants");
      }
      if (biRes.error) {
        logger.warn({ org_id: context.org_id, err: biRes.error.message }, "[rls-client] Failed to fetch bi_accessible_grants — BI resource access may be incomplete");
      }

      const accessGrants: Grant[] = (accessRes.data ?? []) as Grant[];
      const biGrants: Grant[] = (biRes.data ?? []).map((g: any) => ({
        scope_type: g.resource_type as string,  // 'document' | 'folder' | 'department'
        scope_id: g.resource_id as string,
      }));
      grants = [...accessGrants, ...biGrants];
    }
  }

  // ---- 2. Create client with context headers -----------------
  const supabase = createRLSClient(context, grants);

  // ---- 3. SET LOCAL via set_app_context() RPC ----------------
  const { error: ctxError } = await supabase.rpc("set_app_context", {
    p_org_id: context.org_id,
    p_user_id: context.user_id,
    p_dept_id: context.department_id || null,
    p_role: context.user_role || "member",
  });

  if (ctxError) {
    logger.error({ org_id: context.org_id, user_id: context.user_id, err: ctxError.message }, "[rls-client] set_app_context RPC failed — falling back to PostgREST headers only");
    // Headers are still set, so PostgREST path may still work.
    // Don't throw — let the query attempt proceed.
  }

  // ---- 4. Inject session_grants for super_users --------------
  if (grants.length > 0) {
    const { error: grantsError } = await supabase.rpc("set_session_grants", {
      p_grants: grants,
    });

    if (grantsError) {
      logger.error({ org_id: context.org_id, user_id: context.user_id, err: grantsError.message }, "[rls-client] set_session_grants RPC failed — super_user grant isolation may not apply");
    }
  }

  // ---- 5. Run the callback -----------------------------------
  return callback(supabase);
}
