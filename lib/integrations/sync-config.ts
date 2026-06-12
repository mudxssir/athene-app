// ============================================================
// integrations/sync-config.ts — Selective sync configuration
//
// Defines the shape of a connection's sync_config column.
// Stored as JSONB on the `connections` table.
//
// When mode is 'all', fetchers behave identically to the
// legacy "sync everything" flow — zero regression risk.
// When mode is 'selected', fetchers scope API calls to
// only the resources the user picked in the browse UI.
// ============================================================

// ---- Types --------------------------------------------------

/**
 * A resource the user explicitly selected for syncing.
 * Stored in the connections.sync_config JSONB column.
 */
export interface SelectedResource {
  /** Provider-specific ID (folder ID, channel ID, repo full_name, etc.) */
  id: string
  /** Human-readable display name */
  name: string
  /** Resource kind — used by fetchers to route correctly */
  type: 'folder' | 'file' | 'channel' | 'repo' | 'database' | 'page' | 'space' | 'project' | 'object_type' | 'workspace' | 'report' | 'dataset' | 'dashboard'
  /** If true, sync this container AND all its children (e.g. a folder + sub-files) */
  includeChildren: boolean
  /** Maps to Athene's departments table — enables department-scoped RAG queries */
  departmentId?: string
  /** Free-text module label (e.g. "Architecture", "Compliance") for finer categorization */
  moduleTag?: string
}

/**
 * Per-resource-type toggle for umbrella providers.
 * E.g. Google Workspace can enable Drive but disable Gmail.
 */
export interface ResourceTypeFilter {
  /** Provider resource type key, e.g. 'issues', 'pull_requests', 'wiki' */
  resourceType: string
  /** Whether this resource type is enabled for syncing */
  enabled: boolean
}

/**
 * The full sync configuration object.
 * Stored as `connections.sync_config` (JSONB, default '{}').
 */
export interface SyncConfig {
  /**
   * 'all'      — fetch everything (legacy default, backwards compatible)
   * 'selected' — fetch only resources listed in selectedResources
   */
  mode: 'all' | 'selected'

  /** Resources the user explicitly selected for syncing. */
  selectedResources?: SelectedResource[]

  /** Resource IDs to explicitly skip (even in 'all' mode). */
  excludedResources?: string[]

  /** Per-resource-type toggles (e.g. sync issues but not PRs). */
  resourceTypeFilters?: ResourceTypeFilter[]

  /**
   * Only fetch items created/received after this ISO-8601 timestamp.
   * Currently used by Gmail to cap how far back the indexer looks.
   * Stored as an ISO string; fetchers convert to provider-specific format.
   */
  afterDate?: string

  /**
   * Slack bot IDs whose messages SHOULD be indexed (P2-9). Bot messages are
   * skipped by default (CI alerts, Jira bots produce noise); orgs whose
   * knowledge lives in bot posts (standup bots, incident bots) list those
   * bot IDs here.
   */
  botAllowlist?: string[]

  /** ISO-8601 timestamp of the last configuration change. */
  lastConfiguredAt?: string
}

// ---- Validation ---------------------------------------------

/**
 * Normalizes a raw JSONB value from the database into a valid SyncConfig.
 * Handles:
 *   - null / undefined / empty object → defaults to { mode: 'all' }
 *   - Invalid mode values → defaults to 'all'
 *   - Missing arrays → defaults to empty arrays
 *
 * This ensures backwards compatibility: existing connections with
 * sync_config = '{}' will continue to sync everything.
 */
export function parseSyncConfig(raw: unknown): SyncConfig {
  if (!raw || typeof raw !== 'object') {
    return { mode: 'all' }
  }

  const obj = raw as Record<string, unknown>

  const mode = obj.mode === 'selected' ? 'selected' : 'all'

  const selectedResources = Array.isArray(obj.selectedResources)
    ? obj.selectedResources.filter(isValidSelectedResource)
    : []

  const excludedResources = Array.isArray(obj.excludedResources)
    ? obj.excludedResources.filter((id): id is string => typeof id === 'string')
    : []

  const resourceTypeFilters = Array.isArray(obj.resourceTypeFilters)
    ? obj.resourceTypeFilters.filter(isValidResourceTypeFilter)
    : []

  const lastConfiguredAt = typeof obj.lastConfiguredAt === 'string'
    ? obj.lastConfiguredAt
    : undefined

  const afterDate = typeof obj.afterDate === 'string' ? obj.afterDate : undefined

  const botAllowlist = Array.isArray(obj.botAllowlist)
    ? obj.botAllowlist.filter((id): id is string => typeof id === 'string')
    : undefined

  return { mode, selectedResources, excludedResources, resourceTypeFilters, afterDate, lastConfiguredAt, botAllowlist }
}

/**
 * Returns the set of selected resource IDs for quick lookup.
 * Returns null if mode is 'all' (= no filtering needed).
 */
export function getSelectedResourceIds(config: SyncConfig): Set<string> | null {
  if (config.mode === 'all') return null
  if (!config.selectedResources || config.selectedResources.length === 0) return null
  return new Set(config.selectedResources.map((r) => r.id))
}

/**
 * Returns the set of excluded resource IDs.
 * These are skipped even in 'all' mode.
 */
export function getExcludedResourceIds(config: SyncConfig): Set<string> {
  return new Set(config.excludedResources ?? [])
}

/**
 * Checks if a specific resource type is enabled.
 * Returns true if there are no filters (backwards compat) or the type is enabled.
 */
export function isResourceTypeEnabled(config: SyncConfig, resourceType: string): boolean {
  if (!config.resourceTypeFilters || config.resourceTypeFilters.length === 0) return true
  const filter = config.resourceTypeFilters.find((f) => f.resourceType === resourceType)
  // If no explicit filter exists for this type, default to enabled
  return filter ? filter.enabled : true
}

/**
 * Validates the shape of a SyncConfig for API input validation.
 * Returns an error message if invalid, null if valid.
 */
export function validateSyncConfig(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return 'sync_config must be a non-null object'
  }

  const obj = input as Record<string, unknown>

  if (obj.mode !== 'all' && obj.mode !== 'selected') {
    return 'sync_config.mode must be "all" or "selected"'
  }

  if (obj.mode === 'selected') {
    if (!Array.isArray(obj.selectedResources) || obj.selectedResources.length === 0) {
      return 'sync_config.selectedResources must be a non-empty array when mode is "selected"'
    }

    for (const res of obj.selectedResources) {
      if (!isValidSelectedResource(res)) {
        return 'Each selectedResource must have id (string), name (string), type (string), and includeChildren (boolean)'
      }
    }
  }

  return null
}

// ---- Internal guards ----------------------------------------

function isValidSelectedResource(r: unknown): r is SelectedResource {
  if (!r || typeof r !== 'object') return false
  const obj = r as Record<string, unknown>
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.type === 'string' &&
    typeof obj.includeChildren === 'boolean'
  )
}

function isValidResourceTypeFilter(f: unknown): f is ResourceTypeFilter {
  if (!f || typeof f !== 'object') return false
  const obj = f as Record<string, unknown>
  return typeof obj.resourceType === 'string' && typeof obj.enabled === 'boolean'
}
