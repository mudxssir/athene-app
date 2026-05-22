export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// ============================================================
// app/api/worker/index/route.ts — Delta re-index worker
//
// QStash-triggered worker that re-fetches and re-indexes a
// specific set of already-known document IDs (e.g. after an
// admin edit, or a targeted content refresh).
//
// Payload: { org_id, document_ids[] }
//
// Flow:
//   1. Verify QStash signature
//   2. Parse and validate payload
//   3. Look up each document + its connection metadata
//   4. Group documents by connection_id
//   5. Dispatch one nango-fetch job per connection, scoped via
//      syncConfigOverride to only re-fetch the target external IDs.
//      The nango-fetch worker handles embed, upsert, and graph-build.
//
// NOTE: This is a DELTA re-indexer — it expects documents to
// already have rows in the documents table. For initial ingestion
// (first sync after connecting a provider) use /api/worker/nango-fetch.
//
// The previous approach called liveDocFetch (a live search fetcher)
// and scanned up to 1000 results per document to find a single chunk
// by chunk_id. That was O(n) and silently missed documents in large
// collections. The new approach dispatches a targeted nango-fetch job
// whose syncConfigOverride points directly at the external IDs to
// re-fetch, avoiding a full-collection scan entirely.
// ============================================================

import { NextResponse } from 'next/server';
import { verifyQStashSignature, checkIdempotency } from '@/lib/qstash/verify';
import { qstash } from '@/lib/qstash/client';
import { supabaseAdmin } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import type { SyncConfig, SelectedResource } from '@/lib/integrations/sync-config';

// ---- Types -------------------------------------------------------

interface IndexPayload {
  org_id: string;
  document_ids: string[];
}

// ---- POST handler ------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  // 1. Verify QStash signature
  const isValid = await verifyQStashSignature(request);
  if (!isValid) {
    return NextResponse.json({ error: 'Invalid QStash signature' }, { status: 401 });
  }

  // 2. Check idempotency
  const isFirstTime = await checkIdempotency(request);
  if (!isFirstTime) {
    logger.info('[index] Skipping duplicate job (idempotency)');
    return NextResponse.json({ status: 'ok', skipped: 'duplicate' });
  }

  // 3. Parse payload
  let payload: IndexPayload;
  try {
    payload = (await request.json()) as IndexPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { org_id, document_ids } = payload;

  if (!org_id || !Array.isArray(document_ids) || document_ids.length === 0) {
    return NextResponse.json(
      { error: 'Missing required fields: org_id, document_ids (non-empty array)' },
      { status: 400 }
    );
  }

  logger.info({ org_id, docsCount: document_ids.length }, '[index] Processing delta re-index');

  try {
    // 4. Fetch document details to get connection info
    const { data: docs, error: fetchErr } = await supabaseAdmin
      .from('documents')
      .select('id, external_id, source_type, connection_id, department_id, visibility')
      .in('id', document_ids)
      .eq('org_id', org_id);

    if (fetchErr) throw fetchErr;
    if (!docs || docs.length === 0) {
      return NextResponse.json({ error: 'Documents not found' }, { status: 404 });
    }

    // 5. Reset extracted hashes so graph-build re-processes them on the next nango-fetch run
    const { error: resetErr } = await supabaseAdmin
      .from('documents')
      .update({ last_extracted_hash: null })
      .eq('org_id', org_id)
      .in('id', document_ids);

    if (resetErr) {
      logger.error({ org_id, err: resetErr.message }, '[index] Failed to reset extracted hashes');
    }

    // 6. Group documents by connection_id — one nango-fetch job per connection
    const byConnection = new Map<string, typeof docs>();
    for (const doc of docs) {
      const group = byConnection.get(doc.connection_id) ?? [];
      group.push(doc);
      byConnection.set(doc.connection_id, group);
    }

    // 7. Look up connection metadata for all affected connections
    const connectionIds = [...byConnection.keys()];
    const { data: connections, error: connErr } = await supabaseAdmin
      .from('connections')
      .select('id, nango_connection_id, provider, source_type, department_id')
      .in('id', connectionIds)
      .eq('org_id', org_id);

    if (connErr) throw connErr;

    const connMap = new Map(
      (connections ?? []).map((c) => [c.id as string, c])
    );

    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is not configured; cannot dispatch nango-fetch jobs');

    // 8. Dispatch one targeted nango-fetch job per connection.
    // syncConfigOverride scopes the job to only the external IDs we care about —
    // this avoids fetching and scanning the full collection (the previous O(n) bug).
    let dispatchedCount = 0;

    for (const [connId, connDocs] of byConnection) {
      const conn = connMap.get(connId);
      if (!conn) {
        logger.warn({ connId }, '[index] Connection not found — skipping group');
        continue;
      }

      const syncConfigOverride: SyncConfig = {
        mode: 'selected',
        selectedResources: connDocs.map((doc) => ({
          id: doc.external_id as string,
          name: '',
          type: (doc.source_type ?? conn.source_type ?? conn.provider) as SelectedResource['type'],
          includeChildren: false,
        })),
      };

      try {
        await qstash.publishJSON({
          url: `${appUrl}/api/worker/nango-fetch`,
          body: {
            orgId: org_id,
            connectionId: connId,
            nangoConnectionId: conn.nango_connection_id,   // Nango string — for provider API calls
            provider: conn.provider,
            sourceType: conn.source_type ?? conn.provider,
            departmentId: connDocs[0].department_id ?? null,
            syncConfigOverride,
          },
        });
        dispatchedCount++;
      } catch (dispatchErr) {
        logger.error(
          {
            connId,
            err: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
          },
          '[index] Failed to dispatch nango-fetch job'
        );
      }
    }

    logger.info(
      { org_id, dispatchedCount, totalDocs: document_ids.length },
      '[index] Re-index jobs dispatched to nango-fetch'
    );

    return NextResponse.json({
      status: 'ok',
      org_id,
      dispatched: dispatchedCount,
      document_ids_queued: document_ids.length,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ org_id, err: message }, '[index] Fatal error');
    return NextResponse.json({ error: `Re-index failed: ${message}` }, { status: 500 });
  }
}
