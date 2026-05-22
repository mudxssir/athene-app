export const dynamic = 'force-dynamic';

// ============================================================
// app/api/worker/graph-build/route.ts — Graph build worker (ATH-60)
//
// QStash-triggered background job that builds/updates the
// knowledge graph after indexing completes.
//
// Payload:
//   { org_id, document_ids[], job_type: 'incremental' | 'full' }
//
// Flow:
//   1. Verify QStash signature (security)
//   2. Parse and validate payload
//   3. Call buildGraphForDocuments()
//   4. Return result summary
// ============================================================

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify'
import { buildGraphForDocuments, type BuildMode } from '@/lib/knowledge-graph/builder'
import { qstash } from '@/lib/qstash/client'
import { logger } from '@/lib/logger'
import { parseBody, uuidSchema, jobTypeSchema } from '@/lib/validation'

// ---- Payload schema -----------------------------------------

const GraphBuildPayloadSchema = z.object({
  org_id:       uuidSchema,
  document_ids: z.array(uuidSchema).optional().default([]),
  job_type:     jobTypeSchema.optional().default('incremental'),
  depth:        z.number().int().min(0).max(50).optional().default(0),
})

type GraphBuildPayload = z.infer<typeof GraphBuildPayloadSchema>

// ---- POST handler -------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Verify QStash signature
  const isValid = await verifyQStashSignature(request)
  if (!isValid) {
    return NextResponse.json(
      { error: 'Invalid QStash signature' },
      { status: 401 },
    )
  }

  // 2. Check idempotency
  const isFirstTime = await checkIdempotency(request)
  if (!isFirstTime) {
    logger.info({}, '[graph-build] Skipping duplicate job (idempotency)')
    return NextResponse.json({ status: 'ok', skipped: 'duplicate' })
  }

  // 3. Parse and validate payload
  let raw: unknown
  try { raw = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const parsedPayload = parseBody(GraphBuildPayloadSchema, raw)
  if (!parsedPayload.success) return parsedPayload.response

  const { org_id, document_ids, job_type, depth } = parsedPayload.data

  // 4. Semantic validation
  if (job_type === 'incremental' && document_ids.length === 0) {
    return NextResponse.json(
      { error: 'incremental mode requires at least one document_id' },
      { status: 400 },
    )
  }

  // 5. Build the graph
  try {
    logger.info(
      { org_id, job_type, docs: document_ids.length },
      '[graph-build] Starting build',
    )

    const result = await buildGraphForDocuments(org_id, document_ids, job_type)

    logger.info(
      {
        org_id,
        processed: result.processedDocs,
        skipped: result.skippedDocs,
        nodes: result.totalNodes,
        edges: result.totalEdges,
        errors: result.errors.length,
      },
      '[graph-build] Batch completed',
    )

    // Recursive re-enqueuing for remaining documents (max depth guard)
    const MAX_DEPTH = 50
    if (result.remainingDocs.length > 0) {
      if (depth >= MAX_DEPTH) {
        logger.error(
          { org_id, depth, remaining: result.remainingDocs.length },
          '[graph-build] Max re-enqueue depth reached — aborting',
        )
        return NextResponse.json({
          status: 'ok',
          warning: 'max_depth_reached',
          remaining: result.remainingDocs.length,
        })
      }

      const graphBuildUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/worker/graph-build`
      try {
        await qstash.publishJSON({
          url: graphBuildUrl,
          body: {
            org_id,
            document_ids: result.remainingDocs,
            job_type: 'incremental',
            depth: depth + 1,
          },
        })
        logger.info(
          { org_id, remaining: result.remainingDocs.length },
          '[graph-build] Re-enqueued remaining documents',
        )
      } catch (enqueueErr: unknown) {
        logger.error(
          { org_id, err: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr) },
          '[graph-build] Failed to re-enqueue remaining documents',
        )
      }
    }

    return NextResponse.json({
      status: 'ok',
      org_id,
      job_type,
      processed_docs: result.processedDocs,
      skipped_docs: result.skippedDocs,
      total_nodes: result.totalNodes,
      total_edges: result.totalEdges,
      errors: result.errors,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ org_id, err: message }, '[graph-build] Fatal error')

    return NextResponse.json(
      { error: `Graph build failed: ${message}` },
      { status: 500 },
    )
  }
}
