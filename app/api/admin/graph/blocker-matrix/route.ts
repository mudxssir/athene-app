// ============================================================
// GET /api/admin/graph/blocker-matrix — P6-8 (PLAN_C §5)
//
// The "who waits on whom" admin surface: dept×dept open cross-dept blocker counts
// + the unowned-blocker gap. Aggregate counts only (the SECURITY DEFINER RPCs
// return no node content). Admin-only, rate-limited.
// ============================================================

import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { resolveUserAccess } from '@/lib/auth/rbac'
import { rateLimit } from '@/lib/redis/client'
import { logger } from '@/lib/logger'
import { getBlockerMatrix } from '@/lib/knowledge-graph/blocker-matrix'

export async function GET() {
  try {
    const { userId, orgId, orgRole } = await auth()
    if (!userId || !orgId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const access = await resolveUserAccess(userId, orgId, orgRole)
    if (access.role !== 'admin' || !access.internal_org_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const { allowed } = await rateLimit(`admin:blocker-matrix:${orgId}`, 120, 3600)
    if (!allowed) {
      return NextResponse.json({ error: 'Rate limit exceeded — try again later' }, { status: 429 })
    }

    const matrix = await getBlockerMatrix(access.internal_org_id)
    return NextResponse.json(matrix)
  } catch (error: unknown) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      '[admin/blocker-matrix] GET Error',
    )
    return NextResponse.json({ error: 'Failed to load blocker matrix' }, { status: 500 })
  }
}
