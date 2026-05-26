import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { mapRole } from "@/lib/auth/clerk";
import { supabaseAdmin } from "@/lib/supabase/server";
import { updateConnectionNangoMetadata } from "@/lib/nango/client";
import { dispatchThrottled } from "@/lib/qstash/client";
import { logger } from "@/lib/logger";
import { parseBody, uuidSchema } from "@/lib/validation";

// Must stay in sync with SelectedResource.type in sync-config.ts
const SELECTED_RESOURCE_TYPES = [
  'folder', 'file', 'channel', 'repo', 'database', 'page',
  'space', 'project', 'object_type', 'workspace', 'report', 'dataset', 'dashboard',
] as const;

const SelectedResourceSchema = z.object({
  id:              z.string(),
  name:            z.string(),
  type:            z.enum(SELECTED_RESOURCE_TYPES),
  includeChildren: z.boolean(),
});

const ConfigureSchema = z.object({
  provider:              z.string().min(1).max(100),
  selectedFolderIds:     z.array(z.string()).optional(),
  selectedResources:     z.array(SelectedResourceSchema).optional(),
  selectedWorkspaceIds:  z.array(z.string()).optional(),
  allowlist:             z.array(z.string()).optional(),
  excludedMimeTypes:     z.array(z.string()).optional(),
  departmentId:          uuidSchema.nullable().optional(),
});

interface Params { params: Promise<{ id: string }> }

// Providers handled by the generic "save syncConfig + dispatch" path.
// hubspot and zendesk are intentionally excluded — they are not browsable
// (removed from BROWSABLE_PROVIDERS in providers.ts) so no selection is ever sent.
const GENERIC_BROWSABLE = new Set([
  'sharepoint', 'notion', 'slack',
  'github', 'jira', 'confluence', 'linear',
  'salesforce', 'onedrive',
  'tableau', 'looker', 'metabase',
]);

const SNOWFLAKE_IDENT_RE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;
const BIGQUERY_IDENT_RE  = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;
const REDSHIFT_IDENT_RE  = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/;

/**
 * PATCH /api/connections/[id]/configure
 *
 * Saves the user's data source selection and dispatches a sync job.
 * The [id] param is the Supabase connections.id UUID.
 *
 * Body (Google Drive):  { provider: 'google_drive', selectedFolderIds: string[] }
 * Body (Snowflake):     { provider: 'snowflake',    allowlist: string[] }
 */
export async function PATCH(request: Request, { params }: Params) {
  const { userId, orgId, orgRole } = await auth();
  if (!userId || !orgId) return new NextResponse("Unauthorized", { status: 401 });
  if (mapRole(orgRole ?? undefined) !== "admin") return new NextResponse("Forbidden", { status: 403 });

  const { id: connectionId } = await params;

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = parseBody(ConfigureSchema, raw);
  if (!parsed.success) return parsed.response;
  const { provider, selectedFolderIds, selectedResources, allowlist, excludedMimeTypes, departmentId, selectedWorkspaceIds } = parsed.data;

  // Resolve Clerk orgId → internal UUID
  const { data: orgData, error: orgErr } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", orgId)
    .maybeSingle();

  if (orgErr || !orgData) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }
  const internalOrgId = orgData.id as string;

  // Verify connection belongs to this org
  const { data: conn, error: connErr } = await supabaseAdmin
    .from("connections")
    .select("id, provider, source_type, nango_connection_id, metadata, department_id")
    .eq("id", connectionId)
    .eq("org_id", internalOrgId)
    .maybeSingle();

  if (connErr || !conn) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const existingMeta = (conn.metadata as Record<string, unknown>) ?? {};

  // Shared dispatch helper — sets status to 'syncing' only after a successful dispatch.
  // If dispatch is throttled (queued), status stays as-is; the worker will update it when it runs.
  async function dispatchSync() {
    const workerUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/worker/nango-fetch`;
    const { dispatched, msgId } = await dispatchThrottled({
      orgId: internalOrgId,
      sourceType: conn!.source_type as string,
      url: workerUrl,
      body: {
        orgId: internalOrgId,
        connectionId,
        nangoConnectionId: conn!.nango_connection_id,
        provider: conn!.provider,
        sourceType: conn!.source_type,
        departmentId: conn!.department_id ?? null,
      },
    });
    if (dispatched) {
      await supabaseAdmin.from("connections").update({ status: "syncing" }).eq("id", connectionId);
    }
    return { dispatched, msgId };
  }

  // ── Google Drive ──────────────────────────────────────────
  if (provider === "google_drive") {
    const ids = selectedFolderIds ?? selectedResources?.map((r) => r.id) ?? [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "At least one file or folder must be selected" }, { status: 400 });
    }

    // Build proper SyncConfig so the fetcher scopes to selected items
    const syncConfig = {
      mode: "selected" as const,
      selectedResources: selectedResources ?? ids.map((id) => ({
        id,
        name: id,
        type: "folder" as const,
        includeChildren: true,
      })),
      lastConfiguredAt: new Date().toISOString(),
    };

    const { error: updateErr } = await supabaseAdmin
      .from("connections")
      .update({
        metadata: { ...existingMeta, selected_folder_ids: ids, excluded_mime_types: excludedMimeTypes ?? [] },
        sync_config: syncConfig,
        department_id: departmentId ?? null,
      })
      .eq("id", connectionId);

    if (updateErr) {
      logger.error({ connectionId, err: updateErr.message }, "[configure] Failed to save Drive selection");
      return NextResponse.json({ error: "Failed to save selection" }, { status: 500 });
    }

    const { dispatched } = await dispatchSync();
    logger.info({ connectionId, itemCount: ids.length, dispatched }, "[configure] Drive configured");
    return NextResponse.json({ success: true, dispatched });
  }

  // ── Power BI ──────────────────────────────────────────────
  if (provider === "powerbi") {
    if (!Array.isArray(selectedWorkspaceIds) || selectedWorkspaceIds.length === 0) {
      return NextResponse.json({ error: "selectedWorkspaceIds must be a non-empty array" }, { status: 400 });
    }

    const { error: updateErr } = await supabaseAdmin
      .from("connections")
      .update({ 
        metadata: { ...existingMeta, selected_workspace_ids: selectedWorkspaceIds },
        department_id: departmentId ?? null
      })
      .eq("id", connectionId);

    if (updateErr) {
      logger.error({ connectionId, err: updateErr.message }, "[configure] Failed to save Power BI selection");
      return NextResponse.json({ error: "Failed to save selection" }, { status: 500 });
    }

    const { dispatched } = await dispatchSync();
    logger.info({ connectionId, workspaceCount: selectedWorkspaceIds.length, dispatched }, "[configure] Power BI configured");
    return NextResponse.json({ success: true, dispatched });
  }

  // ── Snowflake ─────────────────────────────────────────────
  if (provider === "snowflake") {
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
      return NextResponse.json({ error: "allowlist must be a non-empty array" }, { status: 400 });
    }

    const invalid = allowlist.filter((t) => !SNOWFLAKE_IDENT_RE.test(t));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Invalid identifiers (expected DATABASE.SCHEMA.TABLE): ${invalid.join(", ")}` },
        { status: 400 }
      );
    }

    const { error: updateErr } = await supabaseAdmin
      .from("connections")
      .update({ metadata: { ...existingMeta, allowlist } })
      .eq("id", connectionId);

    if (updateErr) {
      logger.error({ connectionId, err: updateErr.message }, "[configure] Failed to save Snowflake allowlist");
      return NextResponse.json({ error: "Failed to save allowlist" }, { status: 500 });
    }

    try {
      await updateConnectionNangoMetadata(conn.nango_connection_id as string, "snowflake", internalOrgId, { allowlist });
    } catch (nangoErr: any) {
      logger.warn({ connectionId, err: nangoErr.message }, "[configure] Nango metadata update failed (non-fatal)");
    }

    const { dispatched } = await dispatchSync();
    logger.info({ connectionId, tableCount: allowlist.length, dispatched }, "[configure] Snowflake configured");
    return NextResponse.json({ success: true, dispatched });
  }

  // ── BigQuery ──────────────────────────────────────────────
  if (provider === "bigquery") {
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
      return NextResponse.json({ error: "allowlist must be a non-empty array" }, { status: 400 });
    }

    const invalid = allowlist.filter((t) => !BIGQUERY_IDENT_RE.test(t));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Invalid identifiers (expected DATASET.TABLE): ${invalid.join(", ")}` },
        { status: 400 }
      );
    }

    const { error: updateErr } = await supabaseAdmin
      .from("connections")
      .update({ metadata: { ...existingMeta, allowlist } })
      .eq("id", connectionId);

    if (updateErr) {
      logger.error({ connectionId, err: updateErr.message }, "[configure] Failed to save BigQuery allowlist");
      return NextResponse.json({ error: "Failed to save allowlist" }, { status: 500 });
    }

    try {
      await updateConnectionNangoMetadata(conn.nango_connection_id as string, "bigquery", internalOrgId, { allowlist });
    } catch (nangoErr: any) {
      logger.warn({ connectionId, err: nangoErr.message }, "[configure] Nango metadata update failed (non-fatal)");
    }

    const { dispatched } = await dispatchSync();
    logger.info({ connectionId, tableCount: allowlist.length, dispatched }, "[configure] BigQuery configured");
    return NextResponse.json({ success: true, dispatched });
  }

  // ── Redshift ──────────────────────────────────────────────
  if (provider === "redshift") {
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
      return NextResponse.json({ error: "allowlist must be a non-empty array" }, { status: 400 });
    }

    const invalid = allowlist.filter((t) => !REDSHIFT_IDENT_RE.test(t));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Invalid identifiers (expected SCHEMA.TABLE or TABLE): ${invalid.join(", ")}` },
        { status: 400 }
      );
    }

    const { error: updateErr } = await supabaseAdmin
      .from("connections")
      .update({ metadata: { ...existingMeta, allowlist } })
      .eq("id", connectionId);

    if (updateErr) {
      logger.error({ connectionId, err: updateErr.message }, "[configure] Failed to save Redshift allowlist");
      return NextResponse.json({ error: "Failed to save allowlist" }, { status: 500 });
    }

    try {
      await updateConnectionNangoMetadata(conn.nango_connection_id as string, "redshift", internalOrgId, { allowlist });
    } catch (nangoErr: any) {
      logger.warn({ connectionId, err: nangoErr.message }, "[configure] Nango metadata update failed (non-fatal)");
    }

    const { dispatched } = await dispatchSync();
    logger.info({ connectionId, tableCount: allowlist.length, dispatched }, "[configure] Redshift configured");
    return NextResponse.json({ success: true, dispatched });
  }

  // ── Generic browsable providers ───────────────────────────
  if (GENERIC_BROWSABLE.has(provider)) {
    const resources = selectedResources ?? []
    const mode: 'selected' | 'all' = resources.length > 0 ? 'selected' : 'all'
    const syncConfig = {
      mode,
      selectedResources: resources,
      lastConfiguredAt: new Date().toISOString(),
    }

    const { error: updateErr } = await supabaseAdmin
      .from("connections")
      .update({
        sync_config: syncConfig,
        department_id: departmentId ?? null,
      })
      .eq("id", connectionId)

    if (updateErr) {
      logger.error({ connectionId, err: updateErr.message }, "[configure] Failed to save selection");
      return NextResponse.json({ error: "Failed to save selection" }, { status: 500 });
    }

    const { dispatched } = await dispatchSync();
    logger.info({ connectionId, provider, resourceCount: resources.length, dispatched }, "[configure] Generic provider configured");
    return NextResponse.json({ success: true, dispatched });
  }

  return NextResponse.json({ error: "Unsupported provider for configuration" }, { status: 400 });
}
