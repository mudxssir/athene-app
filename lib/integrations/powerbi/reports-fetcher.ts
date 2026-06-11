// ============================================================
// integrations/powerbi/reports-fetcher.ts — Power BI content fetcher
//
// Fetches reports, datasets (with schema + DAX measures), and
// dashboards from Power BI. Supports workspace-scoped selective
// sync via SyncConfig.
//
// When mode === 'all': lists all workspaces, fetches everything.
// When mode === 'selected': only fetches from selected workspace IDs.
//
// DAX measures are extracted from /groups/{id}/datasets/{dsId}/measures
// and stored as separate chunks with resource_type: 'powerbi_measure'.
// ============================================================
import { logger } from '@/lib/logger'
import {
  powerbiFetch,
  powerbiFetchScoped,
  listWorkspaces,
  type PowerBIReport,
  type PowerBIDataset,
  type PowerBIDashboard,
  type PowerBIMeasure,
} from './client'
import type { FetchedChunk } from '../base'
import { type SyncConfig, getSelectedResourceIds, getExcludedResourceIds } from '../sync-config'
import { supabaseAdmin } from '@/lib/supabase/server'

/**
 * Fetches Power BI content from one or more workspaces.
 * Respects selective sync configuration and sets department_id.
 *
 * @param connectionId - Nango connection string
 * @param orgId        - Internal org UUID
 * @param syncConfig   - Optional selective sync configuration
 */
export async function fetchPowerBIContent(
  connectionId: string,
  orgId: string,
  syncConfig?: SyncConfig
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []

  // Load connection and department ID from Supabase
  const { data: conn } = await supabaseAdmin
    .from('connections')
    .select('department_id')
    .eq('nango_connection_id', connectionId)
    .maybeSingle()
  const departmentId = conn?.department_id as string | undefined

  // Determine which workspaces to fetch from
  const selectedIds = syncConfig ? getSelectedResourceIds(syncConfig) : null
  const excludedIds = syncConfig ? getExcludedResourceIds(syncConfig) : new Set<string>()

  let workspaces: { id: string; name: string }[]

  if (selectedIds && selectedIds.size > 0) {
    // In selective mode, only fetch from workspaces that are selected
    // (or whose children — reports/datasets — are selected)
    const allWorkspaces = await listWorkspaces(connectionId, orgId)
    workspaces = allWorkspaces.filter((ws) => selectedIds.has(ws.id))

    // Also include workspaces whose child resources are selected
    // The selected IDs may be report/dataset IDs that live inside a workspace
    if (workspaces.length === 0) {
      // If no workspace IDs matched, try fetching all workspaces
      // and filter resources inside each one
      workspaces = allWorkspaces
    }
  } else {
    workspaces = await listWorkspaces(connectionId, orgId)
  }

  // Filter out excluded workspaces
  workspaces = workspaces.filter((ws) => !excludedIds.has(ws.id))

  // Process each workspace
  for (const ws of workspaces) {
    const wsChunks = await fetchWorkspaceContent(
      connectionId, orgId, ws.id, ws.name, selectedIds, excludedIds, departmentId
    )
    chunks.push(...wsChunks)
  }

  // Fallback: if no workspaces found (e.g. no admin scope), try legacy /myorg endpoints
  if (workspaces.length === 0) {
    const legacyChunks = await fetchLegacyContent(connectionId, orgId, departmentId)
    chunks.push(...legacyChunks)
  }

  return chunks
}

/**
 * Fetches all content from a single workspace.
 */
async function fetchWorkspaceContent(
  connectionId: string,
  orgId: string,
  groupId: string,
  workspaceName: string,
  selectedIds: Set<string> | null,
  excludedIds: Set<string>,
  departmentId?: string
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []

  // ── Reports ───────────────────────────────────────────────────
  try {
    const reportsRes = await powerbiFetchScoped<{ value: PowerBIReport[] }>(
      connectionId, orgId, groupId, '/reports'
    )
    const reports = (reportsRes?.value ?? [])
      .filter((r) => !excludedIds.has(r.id))
      .filter((r) => !selectedIds || selectedIds.has(r.id) || selectedIds.has(groupId))

    for (const report of reports) {
      let pageNames = ''
      try {
        const pagesRes = await powerbiFetchScoped<{ value: { name: string; displayName: string }[] }>(
          connectionId, orgId, groupId, `/reports/${report.id}/pages`
        )
        pageNames = (pagesRes?.value ?? []).map((p) => p.displayName).join(', ')
      } catch {
        // Non-fatal
      }

      const chunkMetadata: Record<string, any> = {
        provider: 'powerbi',
        resource_type: 'report',
        report_id: report.id,
        dataset_id: report.datasetId,
        workspace_id: groupId,
        workspace_name: workspaceName,
      }
      if (departmentId) chunkMetadata.department_id = departmentId

      chunks.push({
        chunk_id: `powerbi_report_${report.id}_ws_${groupId}`,
        title: `Power BI Report: ${report.name}`,
        content: [
          report.description,
          pageNames ? `Pages: ${pageNames}` : null,
          `Workspace: ${workspaceName}`,
        ].filter(Boolean).join('\n') || report.name,
        source_url: report.webUrl,
        shape: 'bi_artifact' as const,
        metadata: chunkMetadata as any,
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), workspace: workspaceName }, '[powerbi] Failed to fetch reports')
  }

  // ── Datasets + schema + DAX measures ──────────────────────────
  try {
    const datasetsRes = await powerbiFetchScoped<{ value: PowerBIDataset[] }>(
      connectionId, orgId, groupId, '/datasets'
    )
    const datasets = (datasetsRes?.value ?? [])
      .filter((ds) => !excludedIds.has(ds.id))
      .filter((ds) => !selectedIds || selectedIds.has(ds.id) || selectedIds.has(groupId))

    for (const ds of datasets) {
      // Fetch table schema
      let schemaContent = ''
      try {
        const tablesRes = await powerbiFetchScoped<{
          value: { name: string; columns: { name: string; dataType: string }[] }[]
        }>(connectionId, orgId, groupId, `/datasets/${ds.id}/tables`)
        const tables = tablesRes?.value ?? []
        schemaContent = tables.map((t) => {
          const cols = (t.columns ?? []).map((c) => `${c.name} (${c.dataType})`).join(', ')
          return `Table ${t.name}: ${cols}`
        }).join('\n\n')
      } catch {
        // Non-fatal — some datasets don't expose table metadata
      }

      const datasetMetadata: Record<string, any> = {
        provider: 'powerbi',
        resource_type: 'dataset',
        dataset_id: ds.id,
        workspace_id: groupId,
        workspace_name: workspaceName,
        is_refreshable: String(ds.isRefreshable),
      }
      if (departmentId) datasetMetadata.department_id = departmentId

      chunks.push({
        chunk_id: `powerbi_dataset_${ds.id}_ws_${groupId}`,
        title: `Power BI Dataset: ${ds.name}`,
        content: schemaContent
          ? `Dataset: ${ds.name}\nWorkspace: ${workspaceName}\n\n${schemaContent}`
          : `Dataset: ${ds.name}\nWorkspace: ${workspaceName}`,
        source_url: `https://app.powerbi.com/groups/${groupId}/datasets/${ds.id}`,
        shape: 'bi_artifact' as const,
        metadata: datasetMetadata as any,
      })

      // ── DAX Measures extraction ─────────────────────────────────
      try {
        const measuresRes = await powerbiFetchScoped<{ value: PowerBIMeasure[] }>(
          connectionId, orgId, groupId, `/datasets/${ds.id}/measures`
        )
        const measures = measuresRes?.value ?? []
        for (const measure of measures) {
          const measureMetadata: Record<string, any> = {
            provider: 'powerbi',
            resource_type: 'powerbi_measure',
            dataset_id: ds.id,
            measure_name: measure.name,
            workspace_id: groupId,
            workspace_name: workspaceName,
          }
          if (departmentId) measureMetadata.department_id = departmentId

          chunks.push({
            chunk_id: `powerbi_measure_${ds.id}_${measure.name.replace(/\s+/g, '_')}`,
            title: `Power BI Measure: ${measure.name} (${ds.name})`,
            content: [
              `Measure: ${measure.name}`,
              `Dataset: ${ds.name}`,
              `Workspace: ${workspaceName}`,
              measure.description ? `Description: ${measure.description}` : null,
              `DAX Expression: ${measure.expression}`,
            ].filter(Boolean).join('\n'),
            source_url: `https://app.powerbi.com/groups/${groupId}/datasets/${ds.id}`,
            shape: 'bi_artifact' as const,
            metadata: measureMetadata as any,
          })
        }
      } catch {
        // DAX measures endpoint may not be available for all datasets
        // (e.g. push datasets or datasets without measures) — non-fatal
      }
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), workspace: workspaceName }, '[powerbi] Failed to fetch datasets')
  }

  // ── Dashboards ────────────────────────────────────────────────
  try {
    const dashRes = await powerbiFetchScoped<{ value: PowerBIDashboard[] }>(
      connectionId, orgId, groupId, '/dashboards'
    )
    const dashboards = (dashRes?.value ?? [])
      .filter((d) => !excludedIds.has(d.id))
      .filter((d) => !selectedIds || selectedIds.has(d.id) || selectedIds.has(groupId))

    for (const dash of dashboards) {
      const dashboardMetadata: Record<string, any> = {
        provider: 'powerbi',
        resource_type: 'dashboard',
        dashboard_id: dash.id,
        workspace_id: groupId,
        workspace_name: workspaceName,
      }
      if (departmentId) dashboardMetadata.department_id = departmentId

      chunks.push({
        chunk_id: `powerbi_dashboard_${dash.id}_ws_${groupId}`,
        title: `Power BI Dashboard: ${dash.displayName}`,
        content: `Dashboard: ${dash.displayName}\nWorkspace: ${workspaceName}`,
        source_url: dash.webUrl,
        shape: 'bi_artifact' as const,
        metadata: dashboardMetadata as any,
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), workspace: workspaceName }, '[powerbi] Failed to fetch dashboards')
  }

  return chunks
}

/**
 * Legacy fallback: fetches content via /myorg (no workspace scoping).
 * Used when no workspaces are accessible (e.g. personal workspace only).
 */
async function fetchLegacyContent(
  connectionId: string,
  orgId: string,
  departmentId?: string
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []

  try {
    const reportsRes = await powerbiFetch<{ value: PowerBIReport[] }>(connectionId, orgId, '/reports')
    for (const report of reportsRes?.value ?? []) {
      const reportMetadata: Record<string, any> = {
        provider: 'powerbi',
        resource_type: 'report',
        report_id: report.id,
      }
      if (departmentId) reportMetadata.department_id = departmentId

      chunks.push({
        chunk_id: `powerbi_report_${report.id}`,
        title: `Power BI Report: ${report.name}`,
        content: report.description ?? report.name,
        source_url: report.webUrl,
        shape: 'bi_artifact' as const,
        metadata: reportMetadata as any,
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[powerbi] Legacy reports fetch failed')
  }

  try {
    const datasetsRes = await powerbiFetch<{ value: PowerBIDataset[] }>(connectionId, orgId, '/datasets')
    for (const ds of datasetsRes?.value ?? []) {
      const datasetMetadata: Record<string, any> = {
        provider: 'powerbi',
        resource_type: 'dataset',
        dataset_id: ds.id,
      }
      if (departmentId) datasetMetadata.department_id = departmentId

      chunks.push({
        chunk_id: `powerbi_dataset_${ds.id}`,
        title: `Power BI Dataset: ${ds.name}`,
        content: `Dataset: ${ds.name}`,
        source_url: `https://app.powerbi.com/datasets/${ds.id}`,
        shape: 'bi_artifact' as const,
        metadata: datasetMetadata as any,
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[powerbi] Legacy datasets fetch failed')
  }

  try {
    const dashRes = await powerbiFetch<{ value: PowerBIDashboard[] }>(connectionId, orgId, '/dashboards')
    for (const dash of dashRes?.value ?? []) {
      const dashboardMetadata: Record<string, any> = {
        provider: 'powerbi',
        resource_type: 'dashboard',
        dashboard_id: dash.id,
      }
      if (departmentId) dashboardMetadata.department_id = departmentId

      chunks.push({
        chunk_id: `powerbi_dashboard_${dash.id}`,
        title: `Power BI Dashboard: ${dash.displayName}`,
        content: `Dashboard: ${dash.displayName}`,
        source_url: dash.webUrl,
        shape: 'bi_artifact' as const,
        metadata: dashboardMetadata as any,
      })
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, '[powerbi] Legacy dashboards fetch failed')
  }

  return chunks
}
