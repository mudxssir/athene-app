export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/qstash/verify";
import { runEntityResolutionBackfill } from "@/lib/knowledge-graph/backfill-entity-resolution";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

/**
 * QStash-triggered worker for the entity resolution backfill.
 *
 * Payload: { org_id: string; cursor?: string | null }
 *
 * If the batch returns a nextCursor, the worker re-enqueues itself
 * via QStash so large orgs are processed across multiple invocations
 * without hitting the 300s timeout.
 *
 * Set up in Upstash dashboard or via QStash API:
 *   POST /api/worker/kg-entity-resolution
 *   Body: { "org_id": "<uuid>" }
 *
 * To run for all orgs, POST { "all_orgs": true }.
 */
export async function POST(request: Request): Promise<Response> {
  const isValid = await verifyQStashSignature(request);
  if (!isValid) return new Response("Invalid QStash signature", { status: 401 });

  let body: { org_id?: string; cursor?: string | null; all_orgs?: boolean };
  try {
    body = await request.clone().json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // All-orgs mode: fetch org list and enqueue one job per org
  if (body.all_orgs) {
    const { data: orgs, error } = await supabaseAdmin
      .from("organizations")
      .select("id");

    if (error) {
      logger.error({ err: error.message }, "[worker/kg-entity-resolution] Org fetch failed");
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const qstashToken = process.env.QSTASH_TOKEN;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const endpoint = `${appUrl}/api/worker/kg-entity-resolution`;

    if (qstashToken && appUrl) {
      await Promise.all(
        (orgs ?? []).map((org) =>
          fetch("https://qstash.upstash.io/v2/publish/" + endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${qstashToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ org_id: org.id }),
          })
        )
      );
    }

    return NextResponse.json({ status: "ok", enqueued: orgs?.length ?? 0 });
  }

  const { org_id: orgId, cursor = null } = body;
  if (!orgId) {
    return NextResponse.json({ error: "org_id is required" }, { status: 400 });
  }

  logger.info({ orgId, cursor }, "[worker/kg-entity-resolution] Starting batch");

  try {
    const result = await runEntityResolutionBackfill(orgId, cursor ?? null);

    // Chain to next batch if more work remains
    if (result.nextCursor) {
      const qstashToken = process.env.QSTASH_TOKEN;
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";

      if (qstashToken && appUrl) {
        await fetch(
          `https://qstash.upstash.io/v2/publish/${appUrl}/api/worker/kg-entity-resolution`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${qstashToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ org_id: orgId, cursor: result.nextCursor }),
          }
        );
      }
    }

    logger.info(result, "[worker/kg-entity-resolution] Batch complete");
    return NextResponse.json({ status: "ok", ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ orgId, cursor, err: msg }, "[worker/kg-entity-resolution] Batch failed");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
