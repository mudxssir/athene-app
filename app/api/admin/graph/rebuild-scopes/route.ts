// ============================================================
// POST /api/admin/graph/rebuild-scopes — P6-4 (PLAN_C §3.4)
//
// The full-rebuild escape hatch: tear down this org's scope memberships and
// re-derive them from the flat graph in a paced, resumable background job. Because
// scopes are derivative, this is always safe — the recovery answer to any scope
// consistency bug, and it runs automatically after PIPELINE_VERSION re-index
// migrations (wired in P6-9). Admin-only, rate-limited.
//
// SERVICE-ROLE JUSTIFICATION: the teardown deletes kg_scope_members (SELECT-only
// RLS → service role) scoped by explicit org_id; enqueue is a QStash publish. The
// admin gate (role check) is enforced above before any service-role write.
// ============================================================

import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { resolveUserAccess } from '@/lib/auth/rbac'
import { rateLimit } from '@/lib/redis/client'
import { logger } from '@/lib/logger'
import { HIERARCHY_SCOPES } from '@/lib/config/feature-flags'
import { clearScopeMemberships, enqueueScopeBackfill } from '@/lib/knowledge-graph/scope-backfill'

export async function POST() {
  try {
    const { userId, orgId, orgRole } = await auth()
    if (!userId || !orgId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const access = await resolveUserAccess(userId, orgId, orgRole)
    if (access.role !== 'admin' || !access.internal_org_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (!HIERARCHY_SCOPES) {
      return NextResponse.json({ error: 'Hierarchy scopes are disabled (HIERARCHY_SCOPES off)' }, { status: 409 })
    }

    // Rebuild is heavy — strict limit: 5 per org per hour.
    const { allowed } = await rateLimit(`admin:rebuild-scopes:${orgId}`, 5, 3600)
    if (!allowed) {
      return NextResponse.json({ error: 'Rate limit exceeded — try again later' }, { status: 429 })
    }

    const internalOrgId = access.internal_org_id
    await clearScopeMemberships(internalOrgId)
    enqueueScopeBackfill(internalOrgId)

    logger.info({ orgId: internalOrgId }, '[rebuild-scopes] teardown done, backfill enqueued')
    return NextResponse.json({ status: 'rebuilding' })
  } catch (error: unknown) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      '[admin/rebuild-scopes] POST Error',
    )
    return NextResponse.json({ error: 'Failed to rebuild scopes' }, { status: 500 })
  }
}
