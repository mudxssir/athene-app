// ============================================================
// app/api/oauth/callback/route.ts — OAuth Callback Endpoint
//
// Handles post-authorization callback to save the connection
// mapping and optionally trigger an initial data sync.
//
// ISOLATION: This route is standalone. It duplicates some logic
// from /api/admin/integrations POST to remain independent.
// When wired in, the frontend OAuthConnectButton or the
// integration agent would call this after successful nango.auth().
//
// Flow:
//   1. Validate request (auth + body)
//   2. Save connection to nango_connections table
//   3. Create connections table row (for FK references)
//   4. Optionally dispatch initial sync via QStash/local dispatcher
//   5. Return success with connectionId
// ============================================================

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logger } from '@/lib/logger'

// ---- Request schema ─────────────────────────────────────────

const CallbackSchema = z.object({
  connectionId: z.string().min(1).max(500),
  provider: z.string().min(1).max(100),
  triggerSync: z.boolean().optional().default(true),
})

// ---- POST handler ───────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // NOTE: In production, this route should be protected by Clerk auth.
  // When wired in, add:
  //   import { cachedAuth } from '@/lib/auth/cached-auth'
  //   const { userId, orgId } = await cachedAuth(request)
  //   if (!userId || !orgId) return new Response('Unauthorized', { status: 401 })
  //
  // For now, this is an isolated implementation that demonstrates the flow.

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = CallbackSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 },
    )
  }

  const { connectionId, provider, triggerSync } = parsed.data

  try {
    // ── Step 1: Import dependencies lazily to avoid side-effects ──
    // These imports would work when wired into the app. For isolation,
    // we use dynamic imports so the file compiles even if dependencies
    // aren't available in a standalone context.
    const { saveConnectionMapping } = await import('@/lib/nango/client')
    const { supabaseAdmin } = await import('@/lib/supabase/server')

    // ── Step 2: Resolve org context ──
    // WIRING REQUIRED: Before deploying this route, replace the block below with:
    //
    //   import { cachedAuth } from '@/lib/auth/cached-auth'
    //   const { userId, orgId } = await cachedAuth(request)
    //   if (!userId || !orgId) return new Response('Unauthorized', { status: 401 })
    //
    // The current block accepts orgId from the request body ONLY for local
    // development / isolation testing. It MUST NOT be deployed to production
    // without the auth guard above — any caller could claim any orgId.
    //
    // The check below intentionally hard-fails in production to prevent
    // accidental deployment without auth.
    if (process.env.NODE_ENV === 'production') {
      logger.error({}, '[oauth/callback] Route deployed without auth guard — rejecting all requests')
      return new Response('Not implemented: auth guard required before production use', { status: 501 })
    }

    const orgId = (body as any).orgId as string | undefined
    if (!orgId) {
      return NextResponse.json(
        { error: 'orgId required (dev only — wire in Clerk auth before production)' },
        { status: 400 },
      )
    }

    // ── Step 3: Save to nango_connections table ──
    await saveConnectionMapping(orgId, connectionId, provider)

    // ── Step 4: Create connections table row ──
    // This row is the FK parent for documents and document_embeddings.
    const { error: connError } = await supabaseAdmin
      .from('connections')
      .upsert(
        {
          org_id: orgId,
          nango_connection_id: connectionId,
          provider,
          source_type: provider,
          status: 'active',
        },
        { onConflict: 'org_id, nango_connection_id, provider' },
      )

    if (connError) {
      logger.error(
        { connectionId, provider, err: connError.message },
        '[oauth/callback] Failed to create connections row',
      )
      // Non-fatal — nango_connections row was saved successfully
    }

    // ── Step 5: Optionally dispatch initial sync ──
    if (triggerSync) {
      try {
        // Get the connections row ID for the sync job
        const { data: connRow } = await supabaseAdmin
          .from('connections')
          .select('id')
          .eq('org_id', orgId)
          .eq('nango_connection_id', connectionId)
          .eq('provider', provider)
          .single()

        if (connRow?.id) {
          // Dispatch sync job
          // In production, this would use dispatchThrottled from lib/qstash/client
          // For isolation, we log the intent
          logger.info(
            { orgId, connectionId: connRow.id, provider },
            '[oauth/callback] Would dispatch sync job (not wired)',
          )
        }
      } catch (syncErr) {
        logger.warn(
          { err: syncErr instanceof Error ? syncErr.message : String(syncErr) },
          '[oauth/callback] Failed to dispatch sync — connection saved successfully',
        )
      }
    }

    return NextResponse.json({
      status: 'ok',
      connectionId,
      provider,
      message: 'Connection saved successfully',
    })
  } catch (err) {
    logger.error(
      { connectionId, provider, err: err instanceof Error ? err.message : String(err) },
      '[oauth/callback] Error saving connection',
    )
    return NextResponse.json(
      { error: 'Failed to save connection' },
      { status: 500 },
    )
  }
}
