#!/usr/bin/env npx tsx
// ============================================================
// scripts/setup-nango-providers.ts — Nango Provider Auto-Config
//
// Programmatically configures all 27 integration providers in
// Nango, eliminating the need to visit Nango's dashboard.
//
// Usage:
//   # Interactive mode (prompts for each provider's OAuth credentials):
//   npx tsx scripts/setup-nango-providers.ts
//
//   # From config file:
//   npx tsx scripts/setup-nango-providers.ts --config providers.json
//
//   # List configured providers:
//   npx tsx scripts/setup-nango-providers.ts --list
//
// Config file format (providers.json):
//   {
//     "google-drive": {
//       "client_id": "xxx.apps.googleusercontent.com",
//       "client_secret": "GOCSPX-xxx",
//       "scopes": "https://www.googleapis.com/auth/drive.readonly"
//     },
//     "slack": {
//       "client_id": "xxx",
//       "client_secret": "xxx"
//     }
//   }
//
// ISOLATION: This script reads from lib/integrations/providers.ts
// but does not modify any app files. It only calls Nango's REST API.
// ============================================================

import * as readline from 'readline'
import * as fs from 'fs'

// ---- Types ─────────────────────────────────────────────────

interface ProviderOAuthConfig {
  client_id: string
  client_secret: string
  scopes?: string
}

interface NangoIntegration {
  unique_key: string
  provider: string
  client_id?: string
  client_secret?: string
  scopes?: string
}

// ---- Provider Registry (duplicated to avoid import issues) ──

// We inline a minimal version of the provider registry to avoid
// importing from the app codebase (which may require Next.js env).
// KEEP IN SYNC WITH lib/integrations/providers.ts when adding new providers.

// Nango's `provider` field in PUT /config must be the OAuth provider template slug —
// it's the provider type identifier Nango uses internally, NOT simply the first
// segment of the integration ID. This explicit map avoids the fragile split('-')[0]
// approach. Source: https://nango.dev/providers.yaml
const NANGO_PROVIDER_SLUGS: Record<string, string> = {
  'google-drive':         'google',
  'google-mail':          'google',
  'google-calendar':      'google',
  'google-bigquery':      'google',
  'microsoft-sharepoint': 'microsoft',
  'microsoft-onedrive':   'microsoft',
  'microsoft-outlook':    'microsoft',
  'microsoft-calendar':   'microsoft',
  'microsoft-power-bi':   'microsoft',
  'slack':                'slack',
  'notion':               'notion',
  'hubspot':              'hubspot',
  'salesforce':           'salesforce',
  'zendesk':              'zendesk',
  'github':               'github',
  'linear':               'linear',
  'jira':                 'jira',
  'confluence':           'confluence',
  'snowflake':            'snowflake',
  'redshift':             'redshift',
  'looker':               'looker',
  'tableau':              'tableau',
  'metabase':             'metabase',
  'dbt':                  'dbt',
}

/** Resolve the Nango OAuth provider slug from an integration ID. */
function nangoProviderSlug(integrationId: string): string {
  const slug = NANGO_PROVIDER_SLUGS[integrationId]
  if (!slug) {
    console.warn(
      `  ⚠ No explicit provider slug for "${integrationId}" — add it to NANGO_PROVIDER_SLUGS`,
    )
    // Last-resort fallback: first hyphen segment. May be wrong for unknown providers.
    return integrationId.split('-')[0]
  }
  return slug
}

const PROVIDERS: Array<{
  key: string
  displayName: string
  nangoIntegrationId: string
  category: string
  scopes: string[]
}> = [
  { key: 'google_drive',    displayName: 'Google Drive',     nangoIntegrationId: 'google-drive',          category: 'productivity',  scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
  { key: 'gmail',           displayName: 'Gmail',            nangoIntegrationId: 'google-mail',           category: 'communication', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  { key: 'google_calendar', displayName: 'Google Calendar',  nangoIntegrationId: 'google-calendar',       category: 'productivity',  scopes: ['https://www.googleapis.com/auth/calendar.readonly'] },
  { key: 'sharepoint',      displayName: 'SharePoint',       nangoIntegrationId: 'microsoft-sharepoint',  category: 'productivity',  scopes: ['Sites.Read.All', 'Files.Read.All'] },
  { key: 'onedrive',        displayName: 'OneDrive',         nangoIntegrationId: 'microsoft-onedrive',    category: 'productivity',  scopes: ['Files.Read.All'] },
  { key: 'outlook',         displayName: 'Outlook',          nangoIntegrationId: 'microsoft-outlook',     category: 'communication', scopes: ['Mail.Read'] },
  { key: 'ms_calendar',     displayName: 'Outlook Calendar', nangoIntegrationId: 'microsoft-calendar',    category: 'productivity',  scopes: ['Calendars.Read'] },
  { key: 'slack',           displayName: 'Slack',            nangoIntegrationId: 'slack',                 category: 'communication', scopes: ['channels:history', 'channels:read'] },
  { key: 'notion',          displayName: 'Notion',           nangoIntegrationId: 'notion',                category: 'productivity',  scopes: [] },
  { key: 'hubspot',         displayName: 'HubSpot',          nangoIntegrationId: 'hubspot',               category: 'crm',          scopes: ['crm.objects.contacts.read', 'crm.objects.companies.read'] },
  { key: 'salesforce',      displayName: 'Salesforce',       nangoIntegrationId: 'salesforce',            category: 'crm',          scopes: ['api', 'refresh_token'] },
  { key: 'zendesk',         displayName: 'Zendesk',          nangoIntegrationId: 'zendesk',               category: 'communication', scopes: ['tickets:read', 'help_center:read'] },
  { key: 'github',          displayName: 'GitHub',           nangoIntegrationId: 'github',                category: 'devtools',     scopes: ['repo', 'read:user'] },
  { key: 'linear',          displayName: 'Linear',           nangoIntegrationId: 'linear',                category: 'devtools',     scopes: ['read', 'write'] },
  { key: 'jira',            displayName: 'Jira',             nangoIntegrationId: 'jira',                  category: 'devtools',     scopes: ['read:jira-work'] },
  { key: 'confluence',      displayName: 'Confluence',       nangoIntegrationId: 'confluence',            category: 'devtools',     scopes: ['read:confluence-content.summary'] },
  { key: 'snowflake',       displayName: 'Snowflake',        nangoIntegrationId: 'snowflake',             category: 'data',         scopes: [] },
  { key: 'bigquery',        displayName: 'BigQuery',         nangoIntegrationId: 'google-bigquery',       category: 'data',         scopes: ['https://www.googleapis.com/auth/bigquery.readonly'] },
  { key: 'redshift',        displayName: 'Amazon Redshift',  nangoIntegrationId: 'redshift',              category: 'data',         scopes: [] },
  { key: 'looker',          displayName: 'Looker',           nangoIntegrationId: 'looker',                category: 'data',         scopes: [] },
  { key: 'tableau',         displayName: 'Tableau',          nangoIntegrationId: 'tableau',               category: 'data',         scopes: [] },
  { key: 'metabase',        displayName: 'Metabase',         nangoIntegrationId: 'metabase',              category: 'data',         scopes: [] },
  { key: 'dbt',             displayName: 'dbt Cloud',        nangoIntegrationId: 'dbt',                   category: 'data',         scopes: [] },
  { key: 'powerbi',         displayName: 'Power BI',         nangoIntegrationId: 'microsoft-power-bi',   category: 'data',         scopes: ['Dataset.Read.All', 'Report.Read.All'] },
]

// ---- UI Helpers ─────────────────────────────────────────────

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'

function success(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`) }
function warn(msg: string) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`) }
function error(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`) }
function info(msg: string) { console.log(`  ${DIM}${msg}${RESET}`) }

// ---- Nango API Client ──────────────────────────────────────

class NangoAdmin {
  private secretKey: string
  private host: string

  constructor(secretKey: string, host: string = 'https://api.nango.dev') {
    this.secretKey = secretKey
    this.host = host
  }

  async listIntegrations(): Promise<NangoIntegration[]> {
    const res = await fetch(`${this.host}/config`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    })
    if (!res.ok) throw new Error(`Nango API error: ${res.status}`)
    const data = await res.json()
    return data.configs ?? []
  }

  async createIntegration(config: {
    unique_key: string
    provider: string
    oauth_client_id?: string
    oauth_client_secret?: string
    oauth_scopes?: string
  }): Promise<void> {
    const res = await fetch(`${this.host}/config`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => 'unknown')
      throw new Error(`Nango API error ${res.status}: ${errBody}`)
    }
  }

  async deleteIntegration(uniqueKey: string): Promise<void> {
    const res = await fetch(`${this.host}/config/${uniqueKey}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.secretKey}` },
    })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Nango API error: ${res.status}`)
    }
  }
}

// ---- Readline ──────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question}`, (answer) => resolve(answer.trim()))
  })
}

async function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await ask(`${question} ${suffix}: `)
  if (answer === '') return defaultYes
  return answer.toLowerCase().startsWith('y')
}

// ---- Main ──────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const configFile = args.find((a) => a.startsWith('--config='))?.split('=')[1]
    ?? (args.indexOf('--config') >= 0 ? args[args.indexOf('--config') + 1] : null)
  const listMode = args.includes('--list')

  // Get Nango credentials
  const nangoKey = process.env.NANGO_SECRET_KEY
  const nangoHost = process.env.NANGO_HOST ?? 'https://api.nango.dev'

  if (!nangoKey) {
    error('NANGO_SECRET_KEY environment variable is required.')
    info('Set it in .env.local or run: export NANGO_SECRET_KEY=your_key')
    process.exit(1)
  }

  const nango = new NangoAdmin(nangoKey, nangoHost)

  // List mode
  if (listMode) {
    console.log(`\n${CYAN}${BOLD}Configured Nango Integrations${RESET}\n`)
    try {
      const integrations = await nango.listIntegrations()
      if (integrations.length === 0) {
        info('No integrations configured')
      } else {
        for (const i of integrations) {
          const hasOAuth = !!(i as any).oauth_client_id
          console.log(`  ${hasOAuth ? GREEN + '●' + RESET : YELLOW + '○' + RESET} ${i.unique_key} (${i.provider}) ${hasOAuth ? '' : DIM + '(no OAuth credentials)' + RESET}`)
        }
      }
      console.log(`\n  Total: ${integrations.length} integrations\n`)
    } catch (err) {
      error(`Failed to list: ${err instanceof Error ? err.message : String(err)}`)
    }
    rl.close()
    return
  }

  // Config file mode
  let oauthConfigs: Record<string, ProviderOAuthConfig> = {}

  if (configFile) {
    if (!fs.existsSync(configFile)) {
      error(`Config file not found: ${configFile}`)
      process.exit(1)
    }
    try {
      oauthConfigs = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
      success(`Loaded ${Object.keys(oauthConfigs).length} provider configs from ${configFile}`)
    } catch (err) {
      error(`Failed to parse config file: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  // Interactive setup
  console.log(`\n${CYAN}${BOLD}Athene — Nango Provider Configuration${RESET}\n`)
  info(`Configuring ${PROVIDERS.length} providers at ${nangoHost}`)
  console.log('')

  // Group by category
  const categories = [...new Set(PROVIDERS.map((p) => p.category))]
  let configured = 0
  let skipped = 0
  let failed = 0

  for (const category of categories) {
    const categoryProviders = PROVIDERS.filter((p) => p.category === category)
    console.log(`\n${BOLD}── ${category.toUpperCase()} ──${RESET}`)

    for (const provider of categoryProviders) {
      const existingConfig = oauthConfigs[provider.nangoIntegrationId]

      if (!existingConfig && !configFile) {
        // Interactive: ask if they want to configure this provider
        const configure = await askYesNo(
          `Configure ${provider.displayName} (${provider.nangoIntegrationId})?`,
          false,
        )

        if (!configure) {
          skipped++
          continue
        }

        const clientId = await ask(`  ${provider.displayName} OAuth Client ID: `)
        const clientSecret = await ask(`  ${provider.displayName} OAuth Client Secret: `)

        if (!clientId || !clientSecret) {
          warn(`Skipping ${provider.displayName} — missing credentials`)
          skipped++
          continue
        }

        try {
          await nango.createIntegration({
            unique_key: provider.nangoIntegrationId,
            provider: nangoProviderSlug(provider.nangoIntegrationId),
            oauth_client_id: clientId,
            oauth_client_secret: clientSecret,
            oauth_scopes: provider.scopes.join(' '),
          })
          success(`${provider.displayName} configured`)
          configured++
        } catch (err) {
          error(`${provider.displayName}: ${err instanceof Error ? err.message : String(err)}`)
          failed++
        }
      } else if (existingConfig) {
        // Config file: apply the config
        try {
          await nango.createIntegration({
            unique_key: provider.nangoIntegrationId,
            provider: provider.nangoIntegrationId.split('-')[0],
            oauth_client_id: existingConfig.client_id,
            oauth_client_secret: existingConfig.client_secret,
            oauth_scopes: existingConfig.scopes ?? provider.scopes.join(' '),
          })
          success(`${provider.displayName} configured`)
          configured++
        } catch (err) {
          error(`${provider.displayName}: ${err instanceof Error ? err.message : String(err)}`)
          failed++
        }
      } else {
        skipped++
      }
    }
  }

  console.log(`\n${CYAN}${BOLD}━━━ Summary ━━━${RESET}`)
  console.log(`  ${GREEN}Configured: ${configured}${RESET}`)
  console.log(`  ${YELLOW}Skipped: ${skipped}${RESET}`)
  if (failed > 0) console.log(`  ${RED}Failed: ${failed}${RESET}`)
  console.log('')

  rl.close()
}

main().catch((err) => {
  error(`Script failed: ${err instanceof Error ? err.message : String(err)}`)
  rl.close()
  process.exit(1)
})
