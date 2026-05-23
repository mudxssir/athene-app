export type ProviderKey =
  | 'google'
  | 'microsoft'
  | 'google_drive'
  | 'gmail'
  | 'google_calendar'
  | 'sharepoint'
  | 'onedrive'
  | 'outlook'
  | 'ms_calendar'
  | 'slack'
  | 'hubspot'
  | 'notion'
  | 'jira'
  | 'confluence'
  | 'salesforce'
  | 'snowflake'
  | 'github'
  | 'github-getting-started'
  | 'linear'
  | 'zendesk'
  | 'bigquery'
  | 'redshift'
  | 'looker'
  | 'tableau'
  | 'metabase'
  | 'dbt'
  | 'powerbi';

export type ProviderCategory = "productivity" | "crm" | "devtools" | "communication" | "data";

export interface ProviderCapabilities {
  canFetch: boolean;
  canSearch: boolean;
  canWrite: boolean;
  requiresScopes: string[];
}

export interface ProviderConfig {
  key: ProviderKey;
  displayName: string;
  description: string;
  icon: string;
  category: ProviderCategory;
  nangoIntegrationId: string;
  resources: string[];
  capabilities: ProviderCapabilities;
  hidden?: boolean;
}

export const PROVIDER_REGISTRY: Record<ProviderKey, ProviderConfig> = {
  google: {
    key: 'google',
    displayName: 'Google Workspace',
    description: 'Gmail, Drive, and Calendar',
    icon: '/integrations/gdrive.svg',
    category: 'productivity',
    nangoIntegrationId: 'google',
    resources: ['gmail', 'drive', 'calendar'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'],
    },
    hidden: true,
  },
  microsoft: {
    key: 'microsoft',
    displayName: 'Microsoft 365',
    description: 'Outlook, OneDrive, and SharePoint',
    icon: '/integrations/outlook.svg',
    category: 'productivity',
    nangoIntegrationId: 'microsoft',
    resources: ['messages', 'files', 'sites'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['Mail.Read', 'Files.Read.All', 'Sites.Read.All'],
    },
    hidden: true,
  },
  google_drive: {
    key: 'google_drive',
    displayName: 'Google Drive',
    description: 'Sync and search Drive files and documents',
    icon: '/integrations/gdrive.svg',
    category: 'productivity',
    nangoIntegrationId: 'google-drive',
    resources: ['files', 'folders'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    },
  },
  gmail: {
    key: 'gmail',
    displayName: 'Gmail',
    description: 'Sync and search emails and threads',
    icon: '/integrations/gmail.svg',
    category: 'communication',
    nangoIntegrationId: 'google-mail',
    resources: ['messages', 'threads'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
  },
  google_calendar: {
    key: 'google_calendar',
    displayName: 'Google Calendar',
    description: 'Sync and search calendar events',
    icon: '/integrations/gcalendar.svg',
    category: 'productivity',
    nangoIntegrationId: 'google-calendar',
    resources: ['events'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    },
  },
  sharepoint: {
    key: 'sharepoint',
    displayName: 'SharePoint',
    description: 'Sync and search SharePoint sites and documents',
    icon: '/integrations/sharepoint.svg',
    category: 'productivity',
    nangoIntegrationId: 'microsoft-sharepoint',
    resources: ['sites', 'driveItems'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['Sites.Read.All', 'Files.Read.All'],
    },
  },
  onedrive: {
    key: 'onedrive',
    displayName: 'OneDrive',
    description: 'Sync and search OneDrive files',
    icon: '/integrations/onedrive.svg',
    category: 'productivity',
    nangoIntegrationId: 'microsoft-onedrive',
    resources: ['driveItems'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['Files.Read.All'],
    },
  },
  outlook: {
    key: 'outlook',
    displayName: 'Outlook',
    description: 'Sync and search Outlook emails',
    icon: '/integrations/outlook.svg',
    category: 'communication',
    nangoIntegrationId: 'microsoft-outlook',
    resources: ['messages'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['Mail.Read'],
    },
  },
  ms_calendar: {
    key: 'ms_calendar',
    displayName: 'Outlook Calendar',
    description: 'Sync and search Outlook calendar events',
    icon: '/integrations/mscalendar.svg',
    category: 'productivity',
    nangoIntegrationId: 'microsoft-calendar',
    resources: ['events'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['Calendars.Read'],
    },
  },
  slack: {
    key: 'slack',
    displayName: 'Slack',
    description: 'Index public channels, threads, and search messages live',
    icon: '/integrations/slack.svg',
    category: 'communication',
    nangoIntegrationId: 'slack',
    resources: ['channels', 'messages', 'threads'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['channels:history', 'channels:read', 'groups:history', 'groups:read'],
    },
  },
  hubspot: {
    key: 'hubspot',
    displayName: 'HubSpot',
    description: 'Sync contacts, companies, deals, and notes',
    icon: '/integrations/hubspot.svg',
    category: 'crm',
    nangoIntegrationId: 'hubspot',
    resources: ['contacts', 'companies', 'deals', 'notes'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: true,
      requiresScopes: ['crm.objects.contacts.read', 'crm.objects.companies.read', 'crm.objects.deals.read'],
    },
  },
  notion: {
    key: 'notion',
    displayName: 'Notion',
    description: 'Sync workspace pages, databases, and wikis',
    icon: '/integrations/notion.svg',
    category: 'productivity',
    nangoIntegrationId: 'notion',
    resources: ['pages', 'databases', 'blocks'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: [],
    },
  },
  jira: {
    key: 'jira',
    displayName: 'Jira',
    description: 'Sync issues, sprints, and project boards',
    icon: '/integrations/jira.svg',
    category: 'devtools',
    nangoIntegrationId: 'jira',
    resources: ['issues', 'projects', 'boards'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: true,
      requiresScopes: ['read:jira-work', 'write:jira-work'],
    },
  },
  confluence: {
    key: 'confluence',
    displayName: 'Confluence',
    description: 'Sync spaces, pages, and knowledge base articles',
    icon: '/integrations/confluence.svg',
    category: 'devtools',
    nangoIntegrationId: 'confluence',
    resources: ['pages', 'spaces', 'blogs'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['read:confluence-content.summary', 'read:confluence-space.summary'],
    },
  },
  salesforce: {
    key: 'salesforce',
    displayName: 'Salesforce',
    description: 'Sync accounts, opportunities, and cases',
    icon: '/integrations/salesforce.svg',
    category: 'crm',
    nangoIntegrationId: 'salesforce',
    resources: ['Account', 'Opportunity', 'Case', 'Contact'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: true,
      requiresScopes: ['api', 'refresh_token', 'offline_access'],
    },
  },
  snowflake: {
    key: 'snowflake',
    displayName: 'Snowflake',
    description: 'Query schemas and sync table data for BI analysis',
    icon: '/integrations/snowflake.svg',
    category: 'data',
    nangoIntegrationId: 'snowflake',
    resources: ['tables', 'views', 'schemas'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: [],
    },
  },
  github: {
    key: 'github',
    displayName: 'GitHub',
    description: 'Sync repos, issues, PRs, wikis, and search code',
    icon: '/integrations/github.svg',
    category: 'devtools',
    nangoIntegrationId: 'github',
    resources: ['repos', 'issues', 'pull_requests', 'wiki'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: true,
      requiresScopes: ['repo', 'read:user', 'user:email'],
    },
  },
  'github-getting-started': {
    key: 'github-getting-started',
    displayName: 'GitHub',
    description: 'Sync repos, issues, PRs, wikis, and search code',
    icon: '/integrations/github.svg',
    category: 'devtools',
    // Nango integration ID for the getting-started variant
    nangoIntegrationId: 'github-getting-started',
    resources: ['repos', 'issues', 'pull_requests', 'wiki'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: true,
      requiresScopes: ['repo', 'read:user', 'user:email'],
    },
    hidden: true,
  },
  linear: {
    key: 'linear',
    displayName: 'Linear',
    description: 'Sync issues, cycles, and projects',
    icon: '/integrations/linear.svg',
    category: 'devtools',
    nangoIntegrationId: 'linear',
    resources: ['issues', 'projects', 'cycles', 'teams'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: true,
      requiresScopes: ['read', 'write'],
    },
  },
  zendesk: {
    key: 'zendesk',
    displayName: 'Zendesk',
    description: 'Sync support tickets and help center articles',
    icon: '/integrations/zendesk.svg',
    category: 'communication',
    nangoIntegrationId: 'zendesk',
    resources: ['tickets', 'articles', 'users'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: true,
      requiresScopes: ['tickets:read', 'help_center:read', 'users:read'],
    },
  },
  bigquery: {
    key: 'bigquery',
    displayName: 'BigQuery',
    description: 'Query datasets and sync table samples for BI analysis',
    icon: '/integrations/bigquery.svg',
    category: 'data',
    nangoIntegrationId: 'google-bigquery',
    resources: ['datasets', 'tables', 'views'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    },
  },
  redshift: {
    key: 'redshift',
    displayName: 'Amazon Redshift',
    description: 'Query Redshift clusters and sync table data for BI analysis',
    icon: '/integrations/redshift.svg',
    category: 'data',
    nangoIntegrationId: 'redshift',
    resources: ['tables', 'views', 'schemas'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: [],
    },
  },
  looker: {
    key: 'looker',
    displayName: 'Looker',
    description: 'Sync Looks, Explores, and Dashboards from Looker',
    icon: '/integrations/looker.svg',
    category: 'data',
    nangoIntegrationId: 'looker',
    resources: ['looks', 'dashboards', 'explores'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: [],
    },
  },
  tableau: {
    key: 'tableau',
    displayName: 'Tableau',
    description: 'Sync Tableau workbooks, views, and dashboards',
    icon: '/integrations/tableau.svg',
    category: 'data',
    nangoIntegrationId: 'tableau',
    resources: ['workbooks', 'views', 'datasources'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: [],
    },
  },
  metabase: {
    key: 'metabase',
    displayName: 'Metabase',
    description: 'Sync questions, dashboards, and data from Metabase',
    icon: '/integrations/metabase.svg',
    category: 'data',
    nangoIntegrationId: 'metabase',
    resources: ['questions', 'dashboards', 'databases'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: [],
    },
  },
  dbt: {
    key: 'dbt',
    displayName: 'dbt Cloud',
    description: 'Sync dbt models, jobs, and run results for data lineage context',
    icon: '/integrations/dbt.svg',
    category: 'data',
    nangoIntegrationId: 'dbt',
    resources: ['models', 'jobs', 'runs'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: [],
    },
  },
  powerbi: {
    key: 'powerbi',
    displayName: 'Power BI',
    description: 'Sync Power BI reports, datasets, and dashboards',
    icon: '/integrations/powerbi.svg',
    category: 'data',
    nangoIntegrationId: 'microsoft-power-bi',
    resources: ['reports', 'datasets', 'dashboards'],
    capabilities: {
      canFetch: true,
      canSearch: true,
      canWrite: false,
      requiresScopes: ['Dataset.Read.All', 'Report.Read.All', 'Dashboard.Read.All', 'Tenant.Read.All'],
    },
  },
};

/**
 * Returns the configuration for a specific provider.
 */
export function getProvider(key: ProviderKey): ProviderConfig {
  return PROVIDER_REGISTRY[key];
}

/**
 * Legacy alias for getProvider.
 */
export function getProviderConfig(key: ProviderKey): ProviderConfig {
  return getProvider(key);
}

/**
 * Returns a provider configuration by its Nango unique key.
 */
export function getProviderByNangoKey(nangoKey: string): ProviderConfig | undefined {
  return Object.values(PROVIDER_REGISTRY).find((p) => p.nangoIntegrationId === nangoKey);
}

/**
 * Returns all providers belonging to a specific category.
 */
export function getProvidersByCategory(category: string): ProviderConfig[] {
  return Object.values(PROVIDER_REGISTRY).filter((p) => p.category === category);
}

/**
 * Returns all providers that support write operations.
 */
export function getWriteProviders(): ProviderConfig[] {
  return Object.values(PROVIDER_REGISTRY).filter((p) => p.capabilities.canWrite);
}

/**
 * Returns all registered providers.
 */
export function getAllProviders(): ProviderConfig[] {
  return Object.values(PROVIDER_REGISTRY).filter((p) => !p.hidden);
}
/**
 * List of all registered providers.
 */
export const PROVIDERS = Object.values(PROVIDER_REGISTRY);

/**
 * Providers that support granular resource browsing (folder/channel picker).
 * Client-safe — no server imports. Mirrors the keys of providerBrowserMap in browsing.ts.
 */
export const BROWSABLE_PROVIDERS = new Set<ProviderKey>([
  'google_drive', 'google', 'gmail', 'google_calendar',
  'slack', 'notion', 'github',
  'outlook', 'ms_calendar', 'onedrive', 'sharepoint',
  'hubspot', 'salesforce', 'jira', 'confluence', 'linear',
  'zendesk', 'looker', 'tableau', 'metabase', 'dbt',
  'snowflake', 'bigquery', 'redshift', 'powerbi',
]);

/** Returns true if the provider supports the resource browser picker. Client-safe. */
export function isBrowsable(provider: ProviderKey): boolean {
  return BROWSABLE_PROVIDERS.has(provider);
}
