// ============================================================
// lib/agents/integration-agent.ts — Integration Agent (ATH-XX)
//
// Conversational agent that manages data source connections.
// Users can say "connect my Google Drive", "what integrations
// do I have?", "disconnect Slack", or "sync status" in chat.
//
// Follows the same pattern as email-agent.ts:
//   - LLM extracts intent + provider from conversation
//   - Read-only actions (list, status) return AIMessage directly
//   - Write actions (connect, disconnect) use HITL approval gate
//   - Never executes destructive actions without user confirmation
//
// ISOLATION: This file is standalone. To wire it in:
//   1. Add integration-agent.ts node wrapper in lib/langgraph/nodes/
//   2. Register node in lib/langgraph/graph.ts
//   3. Add routing rule in supervisor prompt
// ============================================================

import { AIMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { resolveModelClient } from '../langgraph/llm-factory'
import type { AtheneState, AtheneStateUpdate } from '../langgraph/state'
import { logger } from '../logger'
import { PROVIDER_REGISTRY, getAllProviders } from '../integrations/providers'
import type { ProviderConfig } from '../integrations/providers'

// ---- System Prompt ─────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Athene Integration Management Agent.

Your job is to help users manage their data source connections. You can list connected integrations, initiate new connections, check sync status, trigger re-syncs, and disconnect sources.

## Rules

1. Return ONLY a valid JSON object — no markdown fences, no commentary.
2. Extract the user's intent and the target provider from the conversation.
3. If the user mentions a provider by name (e.g., "Google Drive", "Slack", "Salesforce"), resolve it to the correct provider key.
4. If the intent is unclear, set action to "list" to show available integrations.
5. For "connect" actions, include the provider key. The frontend will handle the OAuth flow.
6. For "disconnect" actions, include the provider key. This requires user confirmation.

## Available Providers

{providers_list}

## Output Schema

{
  "action": "list" | "connect" | "disconnect" | "status" | "sync",
  "provider": "provider_key or null",
  "reasoning": "brief explanation of why this action was chosen"
}`

// ---- Intent Schema ─────────────────────────────────────────

const IntentSchema = z.object({
  action: z.enum(['list', 'connect', 'disconnect', 'status', 'sync']),
  provider: z.string().nullable(),
  reasoning: z.string(),
})

type IntentAction = z.infer<typeof IntentSchema>

// ---- Provider Resolution ───────────────────────────────────

/**
 * Fuzzy-match a user's provider mention to a ProviderConfig.
 * Handles variations like "google drive", "gdrive", "Google", "GDrive", etc.
 */
function resolveProvider(mention: string | null): ProviderConfig | null {
  if (!mention) return null

  const normalized = mention.toLowerCase().replace(/[-_\s]+/g, '')

  // Direct key match
  if (PROVIDER_REGISTRY[mention as keyof typeof PROVIDER_REGISTRY]) {
    return PROVIDER_REGISTRY[mention as keyof typeof PROVIDER_REGISTRY]
  }

  // Fuzzy match against display names and keys
  const allProviders = getAllProviders()
  for (const p of allProviders) {
    const keyNorm = p.key.toLowerCase().replace(/[-_\s]+/g, '')
    const nameNorm = p.displayName.toLowerCase().replace(/[-_\s]+/g, '')

    if (keyNorm === normalized || nameNorm === normalized) return p
    if (keyNorm.includes(normalized) || normalized.includes(keyNorm)) return p
    if (nameNorm.includes(normalized) || normalized.includes(nameNorm)) return p
  }

  return null
}

// ---- Action Handlers ───────────────────────────────────────

/**
 * Normalize a provider key from any format to ProviderConfig.key format.
 *
 * Nango may return the internal key ("google_drive") stored in
 * nango_connections.provider_config_key, or the Nango integration ID
 * ("google-drive") from the connection object when falling back to the
 * Nango API directly. Replacing hyphens with underscores makes both formats
 * match our ProviderConfig.key values (which always use underscores).
 */
function normalizeKey(raw: string): string {
  return raw.replace(/-/g, '_')
}

/**
 * List all available and connected integrations.
 */
async function handleList(
  state: AtheneState,
): Promise<AtheneStateUpdate> {
  const { orgId } = state

  try {
    const { listConnections } = await import('../nango/client')
    const connections = await listConnections(orgId)

    const connectedKeys = new Set(
      connections.map((c: any) => {
        const raw = c.provider_config_key || c.provider || ''
        return normalizeKey(raw)
      })
    )

    const available = getAllProviders()
    const connected = available.filter((p) => connectedKeys.has(normalizeKey(p.key)))
    const notConnected = available.filter((p) => !connectedKeys.has(normalizeKey(p.key)))

    const lines: string[] = []

    if (connected.length > 0) {
      lines.push('**Connected integrations:**')
      for (const p of connected) {
        const conn = connections.find(
          (c: any) => normalizeKey(c.provider_config_key || c.provider || '') === normalizeKey(p.key)
        )
        const syncStatus = conn?.sync_status ?? 'unknown'
        const lastSync = conn?.last_synced_at
          ? new Date(conn.last_synced_at).toLocaleString()
          : 'never'
        lines.push(`- ${p.displayName} — Status: ${syncStatus}, Last sync: ${lastSync}`)
      }
    }

    if (notConnected.length > 0) {
      lines.push('')
      lines.push(`**Available to connect (${notConnected.length}):**`)
      // Group by category
      const byCategory = new Map<string, ProviderConfig[]>()
      for (const p of notConnected) {
        const cat = p.category
        if (!byCategory.has(cat)) byCategory.set(cat, [])
        byCategory.get(cat)!.push(p)
      }
      for (const [category, providers] of byCategory) {
        lines.push(`  *${category}*: ${providers.map((p) => p.displayName).join(', ')}`)
      }
    }

    if (connected.length === 0 && notConnected.length === 0) {
      lines.push('No integrations are configured. Ask me to connect one!')
    }

    return {
      messages: [new AIMessage({ content: lines.join('\n') })],
    }
  } catch (err) {
    logger.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      '[integration-agent] Error listing connections',
    )
    return {
      messages: [
        new AIMessage({
          content:
            'I had trouble fetching your integrations. Please try again in a moment.',
        }),
      ],
    }
  }
}

/**
 * Initiate a new OAuth connection.
 * Returns an AIMessage with instructions and sets pending_write_action
 * so the connection is saved after the user completes OAuth.
 */
async function handleConnect(
  state: AtheneState,
  provider: ProviderConfig,
): Promise<AtheneStateUpdate> {
  // The actual OAuth flow is handled entirely by the frontend — not by action-executor.
  //
  // HITL contract for tool: "integration-connect"
  // ─────────────────────────────────────────────
  // 1. This function sets awaiting_approval=true and pending_write_action.tool="integration-connect".
  // 2. The graph pauses (interruptBefore: ["action_executor"]) and the client receives the state.
  // 3. The frontend detects pending_write_action.tool === "integration-connect" and renders
  //    an Approve button that, when clicked, calls nango.auth(nangoIntegrationId, connectionId)
  //    directly (e.g. via <OAuthConnectButton>) — no server round-trip for the OAuth popup.
  // 4. After OAuth completes, the frontend POSTs to /api/admin/integrations to save the connection.
  // 5. The frontend then POSTs to /api/agent/approve to resume the graph.
  //
  // IMPORTANT: action-executor.ts must NOT try to execute this action server-side.
  // When wiring in, add a pass-through case in action-executor.ts:
  //   case "integration-connect":
  //     // No-op: OAuth flow was handled client-side before approval was sent.
  //     return { messages: [new AIMessage({ content: "Connected successfully!" })] }
  //
  // The agent's role here is to:
  // 1. Confirm which provider to connect and explain what permissions will be requested
  // 2. Set pending_write_action so the frontend knows to render the OAuth trigger UI
  // 3. Pause execution until the user explicitly approves (opens the consent screen)

  return {
    run_status: 'awaiting_approval',
    awaiting_approval: true,
    pending_write_action: {
      tool: 'integration-connect',
      payload: {
        provider: provider.key,
        displayName: provider.displayName,
        nangoIntegrationId: provider.nangoIntegrationId,
        scopes: provider.capabilities.requiresScopes,
      },
      requested_at: new Date().toISOString(),
    },
    messages: [
      new AIMessage({
        content: [
          `I'll help you connect **${provider.displayName}**.`,
          '',
          `This will open ${provider.displayName}'s authorization page where you'll grant Athene read access to your ${provider.resources.join(', ')}.`,
          '',
          `**Permissions requested:** ${provider.capabilities.requiresScopes.length > 0 ? provider.capabilities.requiresScopes.join(', ') : 'Standard read access'}`,
          '',
          'Click **Approve** to open the authorization window, or **Reject** to cancel.',
        ].join('\n'),
      }),
    ],
  }
}

/**
 * Disconnect an existing integration.
 * Requires HITL approval since it deletes indexed data.
 */
async function handleDisconnect(
  state: AtheneState,
  provider: ProviderConfig,
): Promise<AtheneStateUpdate> {
  const { orgId } = state

  // Verify the connection exists before requesting approval
  try {
    const { listConnections } = await import('../nango/client')
    const connections = await listConnections(orgId)

    // Use the same key normalization as handleList — Nango may return either the
    // internal key ("google_drive") or the integration ID ("google-drive") depending
    // on whether the row comes from Supabase or the Nango API fallback path.
    const existing = connections.find(
      (c: any) => normalizeKey(c.provider_config_key || c.provider || '') === normalizeKey(provider.key)
    )

    if (!existing) {
      return {
        messages: [
          new AIMessage({
            content: `${provider.displayName} is not currently connected. Nothing to disconnect.`,
          }),
        ],
      }
    }

    return {
      run_status: 'awaiting_approval',
      awaiting_approval: true,
      pending_write_action: {
        tool: 'integration-disconnect',
        payload: {
          // provider.key is the internal key (e.g. "google_drive") — action-executor
          // passes this to deleteConnection() as providerConfigKey, which resolves
          // to nangoIntegrationId internally via getProvider().
          provider: provider.key,
          displayName: provider.displayName,
          connectionId: (existing as any).connection_id ?? (existing as any).id,
        },
        requested_at: new Date().toISOString(),
      },
      messages: [
        new AIMessage({
          content: [
            `Are you sure you want to disconnect **${provider.displayName}**?`,
            '',
            'This will:',
            '- Remove the OAuth connection',
            '- Delete all indexed documents from this source',
            '- Remove related knowledge graph nodes',
            '',
            'This action cannot be undone. Click **Approve** to proceed or **Reject** to cancel.',
          ].join('\n'),
        }),
      ],
    }
  } catch (err) {
    logger.error(
      { orgId, provider: provider.key, err: err instanceof Error ? err.message : String(err) },
      '[integration-agent] Error checking connection for disconnect',
    )
    return {
      messages: [
        new AIMessage({
          content: 'I had trouble checking your connections. Please try again.',
        }),
      ],
    }
  }
}

/**
 * Check sync status for a specific provider or all providers.
 */
async function handleStatus(
  state: AtheneState,
  provider: ProviderConfig | null,
): Promise<AtheneStateUpdate> {
  const { orgId } = state

  try {
    const { supabaseAdmin } = await import('../supabase/server')

    let query = supabaseAdmin
      .from('connections')
      .select('id, provider, source_type, status, last_synced_at, created_at')
      .eq('org_id', orgId)

    if (provider) {
      query = query.eq('provider', provider.key)
    }

    const { data: connections, error } = await query
    if (error) throw error

    if (!connections || connections.length === 0) {
      const msg = provider
        ? `${provider.displayName} is not connected.`
        : 'No integrations are connected yet.'
      return { messages: [new AIMessage({ content: msg })] }
    }

    // Get document counts per connection
    const connectionIds = connections.map((c: any) => c.id)
    const { data: docCounts } = await supabaseAdmin
      .from('documents')
      .select('connection_id')
      .in('connection_id', connectionIds)

    const countMap = new Map<string, number>()
    for (const doc of docCounts ?? []) {
      const key = doc.connection_id
      countMap.set(key, (countMap.get(key) ?? 0) + 1)
    }

    const lines = ['**Sync Status:**', '']
    for (const conn of connections) {
      const config = resolveProvider(conn.provider)
      const name = config?.displayName ?? conn.provider
      const docs = countMap.get(conn.id) ?? 0
      const lastSync = conn.last_synced_at
        ? new Date(conn.last_synced_at).toLocaleString()
        : 'never'

      lines.push(`**${name}**`)
      lines.push(`- Status: ${conn.status}`)
      lines.push(`- Documents indexed: ${docs}`)
      lines.push(`- Last synced: ${lastSync}`)
      lines.push(`- Connected since: ${new Date(conn.created_at).toLocaleDateString()}`)
      lines.push('')
    }

    return { messages: [new AIMessage({ content: lines.join('\n') })] }
  } catch (err) {
    logger.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      '[integration-agent] Error fetching status',
    )
    return {
      messages: [
        new AIMessage({
          content: 'I had trouble fetching sync status. Please try again.',
        }),
      ],
    }
  }
}

/**
 * Trigger a re-sync for a specific provider.
 */
async function handleSync(
  state: AtheneState,
  provider: ProviderConfig | null,
): Promise<AtheneStateUpdate> {
  if (!provider) {
    return {
      messages: [
        new AIMessage({
          content:
            'Which integration would you like to re-sync? Please specify the provider (e.g., "sync Google Drive").',
        }),
      ],
    }
  }

  const { orgId } = state

  try {
    const { supabaseAdmin } = await import('../supabase/server')

    // Find the connection
    const { data: conn } = await supabaseAdmin
      .from('connections')
      .select('id, nango_connection_id')
      .eq('org_id', orgId)
      .eq('provider', provider.key)
      .single()

    if (!conn) {
      return {
        messages: [
          new AIMessage({
            content: `${provider.displayName} is not connected. Connect it first before syncing.`,
          }),
        ],
      }
    }

    // Mark as syncing
    await supabaseAdmin
      .from('connections')
      .update({ status: 'syncing' })
      .eq('id', conn.id)

    // In production, this would dispatch via QStash:
    //   await dispatchThrottled(orgId, conn.id, conn.nango_connection_id, provider.key, provider.key)
    // For isolation, we log the intent.
    logger.info(
      { orgId, connectionId: conn.id, provider: provider.key },
      '[integration-agent] Would dispatch re-sync job (not wired)',
    )

    return {
      messages: [
        new AIMessage({
          content: [
            `Re-syncing **${provider.displayName}**...`,
            '',
            'The sync will run in the background and typically takes 1-5 minutes depending on the amount of data.',
            'You can check the progress anytime by asking me "sync status".',
          ].join('\n'),
        }),
      ],
    }
  } catch (err) {
    logger.error(
      { orgId, provider: provider.key, err: err instanceof Error ? err.message : String(err) },
      '[integration-agent] Error triggering sync',
    )
    return {
      messages: [
        new AIMessage({
          content: `I had trouble triggering a re-sync for ${provider.displayName}. Please try again.`,
        }),
      ],
    }
  }
}

// ---- Main Node Function ────────────────────────────────────

/**
 * Integration agent node — manages data source connections conversationally.
 *
 * Routes to action handlers based on LLM-extracted intent.
 * Read-only actions (list, status) return AIMessage directly.
 * Write actions (connect, disconnect) use HITL approval gate.
 */
export async function integrationAgentNode(
  state: AtheneState,
): Promise<AtheneStateUpdate> {
  const { orgId, messages } = state

  // Build providers list for the system prompt
  const providers = getAllProviders()
  const providersList = providers
    .map((p) => `- ${p.key}: ${p.displayName} (${p.category}) — ${p.description}`)
    .join('\n')

  const systemContent = SYSTEM_PROMPT.replace('{providers_list}', providersList)

  // Extract user intent via LLM
  try {
    const llm = await resolveModelClient('medium', orgId)
    const structuredModel = llm.withStructuredOutput(IntentSchema, {
      method: 'functionCalling',
    })

    const response = await structuredModel.invoke([
      { role: 'system', content: systemContent },
      ...messages,
    ])

    const intent: IntentAction = response
    const provider = resolveProvider(intent.provider)

    logger.info(
      {
        action: intent.action,
        provider: intent.provider,
        resolved: provider?.key ?? null,
        reasoning: intent.reasoning,
      },
      '[integration-agent] Intent extracted',
    )

    // Route to action handler
    switch (intent.action) {
      case 'list':
        return handleList(state)

      case 'connect':
        if (!provider) {
          return {
            messages: [
              new AIMessage({
                content:
                  "I'd like to help you connect an integration, but I'm not sure which one you mean. " +
                  'Here are the available options:\n\n' +
                  providers.map((p) => `- **${p.displayName}** — ${p.description}`).join('\n'),
              }),
            ],
          }
        }
        return handleConnect(state, provider)

      case 'disconnect':
        if (!provider) {
          return {
            messages: [
              new AIMessage({
                content:
                  'Which integration would you like to disconnect? Please specify the provider name.',
              }),
            ],
          }
        }
        return handleDisconnect(state, provider)

      case 'status':
        return handleStatus(state, provider)

      case 'sync':
        return handleSync(state, provider)

      default:
        return handleList(state)
    }
  } catch (err) {
    logger.error(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      '[integration-agent] LLM intent extraction failed',
    )

    // Fallback: try to list integrations
    return handleList(state)
  }
}
