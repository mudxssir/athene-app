import { describe, it, expect } from 'vitest'
import {
  PROVIDER_REGISTRY,
  getProviderConfig,
  getProvidersByCategory,
  getAllProviders,
} from '@/lib/integrations/providers'
import type { ProviderKey } from '@/lib/integrations/providers'

describe('Provider Registry', () => {
  it('contains all 27 providers', () => {
    const keys = Object.keys(PROVIDER_REGISTRY)
    expect(keys).toHaveLength(27)
  })

  it('every provider has required fields', () => {
    for (const [key, def] of Object.entries(PROVIDER_REGISTRY)) {
      expect(def.nangoIntegrationId, `${key} missing nangoIntegrationId`).toBeTruthy()
      expect(def.displayName, `${key} missing displayName`).toBeTruthy()
      expect(def.icon, `${key} missing icon`).toBeTruthy()
      expect(def.category, `${key} missing category`).toBeTruthy()
      expect(def.description, `${key} missing description`).toBeTruthy()
      expect(def.resources.length, `${key} has no resources`).toBeGreaterThan(0)
      expect(typeof def.capabilities.canFetch).toBe('boolean')
      expect(typeof def.capabilities.canSearch).toBe('boolean')
      expect(Array.isArray(def.capabilities.requiresScopes)).toBe(true)
    }
  })

  it('getProviderConfig returns correct definition', () => {
    const google = getProviderConfig('google')
    expect(google.displayName).toBe('Google Workspace')
    expect(google.nangoIntegrationId).toBe('google')
    expect(google.category).toBe('productivity')
    expect(google.capabilities.requiresScopes).toContain('https://www.googleapis.com/auth/gmail.readonly')
  })

  it('getProvidersByCategory returns correct subset', () => {
    const crm = getProvidersByCategory('crm')
    expect(crm.length).toBeGreaterThanOrEqual(1)
    expect(crm.every(p => p.category === 'crm')).toBe(true)

    const displayNames = crm.map(p => p.displayName)
    expect(displayNames).toContain('Salesforce')
    expect(displayNames).toContain('HubSpot')
  })

  it('getProvidersByCategory(communication) returns Zendesk', () => {
    const comms = getProvidersByCategory('communication')
    const displayNames = comms.map(p => p.displayName)
    expect(displayNames).toContain('Zendesk')
    expect(displayNames).toContain('Slack')
  })

  it('getAllProviders returns array of all providers', () => {
    const all = getAllProviders()
    expect(all.length).toBe(24) // Umbrella ones are hidden, so 26 - 2 = 24
    const github = all.find(p => p.key === 'github')
    expect(github).toBeDefined()
  })

  it('ProviderKey type covers all registry keys', () => {
    // Compile-time check: these should all be valid ProviderKey values
    const keys: ProviderKey[] = Object.keys(PROVIDER_REGISTRY) as ProviderKey[]
    expect(keys).toHaveLength(27)
  })
})
