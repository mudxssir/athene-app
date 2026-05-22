import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { resolveUserAccess } from "@/lib/auth/rbac";
import { NextResponse } from "next/server";

// Define routes that should NOT be protected by Clerk.
// Worker routes (/api/worker/*) authenticate via QStash signature instead of
// Clerk session tokens — they must be reachable without a browser session so
// that server-to-server calls (and QStash webhooks) can hit them directly.
// Nango routes (/api/nango/*) must also be public so that Nango's server-side
// sync-completed webhooks can reach /api/nango/webhook without a Clerk session.
// The webhook route verifies Nango's own HMAC-SHA256 signature independently.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/health",        // unauthenticated — required for load-balancer / k8s probes
  "/api/worker/(.*)",  // authenticated via QStash signature, not Clerk session
  "/api/nango/(.*)",   // authenticated via Nango HMAC-SHA256
]);

/**
 * Clerk Middleware (proxy.ts — Next.js 16 convention)
 * Handles authentication and resolves RBAC context to inject as headers.
 *
 * clockSkewInMs: tolerate up to 60s of system clock drift so local dev
 * works even when NTP sync is slightly off (Clerk nbf check fails otherwise).
 */
export default clerkMiddleware(
  async (auth, request) => {
  if (isPublicRoute(request)) return NextResponse.next();

  // 1. Enforce Authentication for non-public routes
  const { userId, orgId, orgRole } = await auth.protect();

  // 2. Resolve RBAC context (resolves internal UUIDs from Clerk IDs)
  const access = await resolveUserAccess(userId, orgId ?? "", orgRole);

  const requestHeaders = new Headers(request.headers);

  // 3. Inject internal UUIDs — routes query DB with these, not Clerk IDs.
  //    Fall back to Clerk IDs only if RBAC resolution failed (e.g. first visit
  //    before auto-provision completes), so routes can still attempt to work.
  requestHeaders.set("x-current-org-id", access.internal_org_id ?? orgId ?? "");
  requestHeaders.set("x-current-user-id", access.internal_user_id ?? userId ?? "");
  requestHeaders.set("x-current-user-role", access.role ?? "member");
  requestHeaders.set("x-current-user-dept-id", access.dept_id ?? "");
  requestHeaders.set("x-current-accessible-depts", JSON.stringify(access.accessible_dept_ids ?? []));

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
},
{ clockSkewInMs: 60_000 } // tolerate up to 60s NTP drift in local dev
);


export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
