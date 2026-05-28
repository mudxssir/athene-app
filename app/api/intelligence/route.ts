import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { cached } from "@/lib/redis/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const { orgId } = await auth();
  if (!orgId) return new NextResponse("Unauthorized", { status: 401 });

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", orgId)
    .maybeSingle();

  if (!org) return NextResponse.json({ cards: [] });

  const internalOrgId = org.id;

  const data = await cached(`intelligence:${internalOrgId}`, 120, async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const [connectionsRes, newDocsRes, totalDocsRes] = await Promise.all([
      supabaseAdmin
        .from("nango_connections")
        .select("sync_status, last_synced_at")
        .eq("org_id", internalOrgId),
      supabaseAdmin
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("org_id", internalOrgId)
        .gte("created_at", yesterday),
      supabaseAdmin
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("org_id", internalOrgId),
    ]);

    const connections = connectionsRes.data ?? [];
    const connCount = connections.length;
    const healthyCount = connections.filter(
      (c) => c.sync_status === "connected" || c.sync_status === "active"
    ).length;
    const errorCount = connections.filter((c) => c.sync_status === "error").length;

    const lastSync = connections
      .map((c) => c.last_synced_at)
      .filter(Boolean)
      .sort()
      .pop();

    const lastSyncLabel = lastSync
      ? relativeTime(lastSync)
      : "never";

    const newDocs = newDocsRes.count ?? 0;
    const totalDocs = totalDocsRes.count ?? 0;

    return { connCount, healthyCount, errorCount, lastSyncLabel, newDocs, totalDocs };
  });

  const cards = [
    {
      id: "connector_health",
      tone: data.errorCount > 0 ? "warn" : "success",
      title: "Connector Health",
      body:
        data.connCount === 0
          ? "No integrations connected yet. Add a data source to get started."
          : data.errorCount > 0
          ? `${data.errorCount} connector${data.errorCount > 1 ? "s" : ""} have errors. Last sync: ${data.lastSyncLabel}.`
          : `All ${data.connCount} connector${data.connCount > 1 ? "s" : ""} syncing normally. Last sync: ${data.lastSyncLabel}.`,
      query: "What is the current status of all active connectors?",
    },
    {
      id: "knowledge_update",
      tone: "primary",
      title: "Knowledge Update",
      body:
        data.newDocs > 0
          ? `${data.newDocs} new document${data.newDocs > 1 ? "s" : ""} indexed in the last 24 hours. ${data.totalDocs.toLocaleString()} total documents in knowledge base.`
          : `No new documents in the last 24 hours. ${data.totalDocs.toLocaleString()} total documents indexed.`,
      query: "What new information was indexed in the last 24 hours?",
    },
    {
      id: "renewal_risk",
      tone: "warn",
      title: "Renewal Risk",
      body: "Ask Athene to surface accounts with upcoming renewals and low recent engagement.",
      query: "Which enterprise accounts are at renewal risk this quarter?",
    },
    {
      id: "pipeline_gap",
      tone: "amber",
      title: "Pipeline Gap",
      body: "Ask Athene to analyse your pipeline health and identify stalled deals.",
      query: "Show me stalled deals and pipeline gaps this quarter.",
    },
  ];

  return NextResponse.json({ cards });
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
