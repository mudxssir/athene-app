// ============================================================
// lib/knowledge-graph/scope-registry.ts — P6-2 (PLAN_C §1 / §1.1)
//
// The deterministic vocabulary for KG hierarchy scopes: which scopes a node
// belongs to, each scope's stable `key`/`title`, and the parent roll-up chain.
// Pure (no DB, no LLM) so membership maintenance (P6-3) and backfill (P6-4) share
// one source of truth and it is fully unit-testable.
//
// Hierarchy (§1):  App → Vertical → Organization   (+ Department → Organization,
// a separate axis), with Community (per app) and Person scopes cross-cutting.
//
// Vertical = the provider's existing `category` in PROVIDER_REGISTRY
// (productivity / crm / devtools / communication / data) — reused, not reinvented,
// so a new connector inherits its vertical automatically.
//
// Parent chain (§2):  community → app → vertical → org ;  department → org ;
// person → org (person/community do not feed the summary roll-up — see P6-6).
// ============================================================

import { PROVIDER_REGISTRY, type ProviderKey, type ProviderCategory } from '@/lib/integrations/providers'

export type ScopeLevel = 'app' | 'vertical' | 'department' | 'org' | 'community' | 'person'

export interface ScopeDescriptor {
  level: ScopeLevel
  key: string
  title: string
}

/** The single org root every other scope rolls up to. */
export const ORG_SCOPE: ScopeDescriptor = { level: 'org', key: 'root', title: 'Organization' }

/** Human titles for the provider-category verticals. */
const VERTICAL_TITLES: Record<ProviderCategory, string> = {
  productivity: 'Productivity & Docs',
  crm: 'Sales & CRM',
  devtools: 'Engineering',
  communication: 'Communication',
  data: 'Data & BI',
}

/** The vertical (provider category) for a provider, or null if unknown. */
export function verticalForProvider(provider: string): ProviderCategory | null {
  return PROVIDER_REGISTRY[provider as ProviderKey]?.category ?? null
}

/** App scope for a syncing provider (key = provider string). null for empty input. */
export function appScope(provider: string): ScopeDescriptor | null {
  if (!provider) return null
  const cfg = PROVIDER_REGISTRY[provider as ProviderKey]
  return { level: 'app', key: provider, title: cfg?.displayName ?? provider }
}

/** Vertical scope for a provider (key = category), or null when the provider is unknown. */
export function verticalScope(provider: string): ScopeDescriptor | null {
  const cat = verticalForProvider(provider)
  return cat ? { level: 'vertical', key: cat, title: VERTICAL_TITLES[cat] } : null
}

/** Department scope (key = department uuid). */
export function departmentScope(departmentId: string, name?: string): ScopeDescriptor {
  return { level: 'department', key: departmentId, title: name ?? 'Department' }
}

/**
 * Community scope (L1 community within an app). Key embeds the provider so the
 * scope is unique per app and its parent app is derivable: `${provider}#${id}`.
 */
export function communityScope(provider: string, communityId: number | string, title?: string): ScopeDescriptor {
  return {
    level: 'community',
    key: `${provider}#${communityId}`,
    title: title ?? `${PROVIDER_REGISTRY[provider as ProviderKey]?.displayName ?? provider} cluster ${communityId}`,
  }
}

/** Person scope (key = org_members.id). */
export function personScope(memberId: string, displayName?: string): ScopeDescriptor {
  return { level: 'person', key: memberId, title: displayName ?? 'Person' }
}

/** Provider encoded in a community scope key (`${provider}#${id}`), or null. */
export function providerOfCommunityKey(key: string): string | null {
  const i = key.indexOf('#')
  return i > 0 ? key.slice(0, i) : null
}

/**
 * The parent scope in the roll-up chain, or null at the root.
 *   community → app (provider from the key) → vertical → org
 *   department → org ;  person → org ;  org → null
 */
export function parentScope(d: ScopeDescriptor): ScopeDescriptor | null {
  switch (d.level) {
    case 'community': {
      const provider = providerOfCommunityKey(d.key)
      return provider ? appScope(provider) : ORG_SCOPE
    }
    case 'app':
      return verticalScope(d.key) ?? ORG_SCOPE
    case 'vertical':
    case 'department':
    case 'person':
      return ORG_SCOPE
    case 'org':
      return null
  }
}

/**
 * The structural scopes a node belongs to, given the provenance the builder/
 * backfill knows: the syncing provider + the node's department_ids. Returns
 * [app?, vertical?, ...departments] — the scopes membership maintenance upserts
 * for a touched node. Community + person memberships are assigned elsewhere
 * (Louvain in P6-5; 2-hop work-graph in P6-7), not from provider provenance.
 */
export function structuralScopesForNode(args: {
  provider: string
  departmentIds?: string[]
  departmentNames?: Record<string, string>
}): ScopeDescriptor[] {
  const out: ScopeDescriptor[] = []
  const app = appScope(args.provider)
  if (app) out.push(app)
  const vertical = verticalScope(args.provider)
  if (vertical) out.push(vertical)
  for (const deptId of args.departmentIds ?? []) {
    if (deptId) out.push(departmentScope(deptId, args.departmentNames?.[deptId]))
  }
  return out
}
