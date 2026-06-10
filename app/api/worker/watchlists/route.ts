export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/qstash/verify";
import { runWatchlistWorker } from "@/lib/watchlists/worker";
import { logger } from "@/lib/logger";

export async function POST(request: Request): Promise<Response> {
  const isValid = await verifyQStashSignature(request);
  if (!isValid) return new Response("Invalid QStash signature", { status: 401 });

  logger.info({}, "[worker/watchlists] Starting watchlist evaluation run");

  try {
    const result = await runWatchlistWorker();
    logger.info(result, "[worker/watchlists] Run complete");
    return NextResponse.json({ status: "ok", ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "[worker/watchlists] Worker failed");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
