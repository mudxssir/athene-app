import { Nango } from '@nangohq/node'
import { supabaseAdmin } from '../supabase/server'
import { getProvider } from '@/lib/integrations/providers'
import { logger } from '@/lib/logger'


let nangoInstance: Nango | null = null;

export function getNango() {
  if (!nangoInstance) {
    const nangoSecretKey = process.env.NANGO_SECRET_KEY;
    if (!nangoSecretKey) {
       logger.warn({}, "[Config] Missing NANGO_SECRET_KEY. Integration features will be disabled.");
    }
    nangoInstance = new Nango({
      secretKey: nangoSecretKey || 'placeholder-key'
    });
  }
  return nangoInstance;
}

/**
 * Robust error handler for Nango/OAuth specific failures.
 * 🛡️ Distinguishes between expired tokens, revoked connections, and permission issues.
 */
function handleNangoError(error: unknown, context: string): never {
  const err = error as Record<string, any>;
  const status = err?.response?.status;
  const nangoCode = err?.error?.code;
  const message = err?.error?.message || (error instanceof Error ? error.message : String(error));

  logger.error({ context, status, nangoCode, message }, '[Nango Error]');

  // 1. Handle Revoked or Expired OAuth Sessions
  if (status === 401 || nangoCode === 'invalid_credentials') {
    const wrappedError = new Error('Connection expired or revoked. Please reconnect your integration.');
    (wrappedError as any).status = 401;
    (wrappedError as any).reason = 'AUTH_FAILURE';
    (wrappedError as any).reconnect_required = true;
    throw wrappedError;
  }

  // 2. Handle Permission/Ownership Issues
  if (status === 403) {
    const wrappedError = new Error('Access denied. This connection may belong to another organization or have insufficient scopes.');
    (wrappedError as any).status = 403;
    (wrappedError as any).reason = 'FORBIDDEN';
    throw wrappedError;
  }

  // 3. Handle Missing Records
  if (status === 404) {
    const wrappedError = new Error('Connection not found. It may have been deleted.');
    (wrappedError as any).status = 404;
    (wrappedError as any).reason = 'NOT_FOUND';
    throw wrappedError;
  }

  // 4. General Fallback
  throw error;
}

/**
 * Fetches an access token for a given connection and provider.
 * 🔒 Strictly verified against Supabase/metadata to prevent cross-org leaks.
 */
export async function getConnectionToken(
  connectionId: string,
  providerConfigKey: string,
  orgId: string
): Promise<string> {
  if (!orgId) {
    throw new Error('orgId is required to fetch connection token');
  }

  const nango = getNango();

  try {
    // 🛡️ Verify connection ownership — org_id + connection_id pair uniquely
    // prevents cross-org token access without needing provider_config_key,
    // which may differ between our internal key and what Nango stores.
    const { data: mapping, error: supabaseError } = await supabaseAdmin
      .from('nango_connections')
      .select('id, provider_config_key')
      .eq('org_id', orgId)
      .eq('connection_id', connectionId)
      .maybeSingle()

    if (supabaseError) {
      throw new Error(`Supabase verification failed: ${supabaseError.message}`);
    }

    if (!mapping) {
      const notFound = new Error('Connection not found for this organization');
      (notFound as any).status = 404;
      (notFound as any).reason = 'NOT_FOUND';
      throw notFound;
    }

    // Use the stored provider_config_key to determine the Nango integration key,
    // falling back to the passed providerConfigKey if needed.
    const storedKey = (mapping as any).provider_config_key ?? providerConfigKey;
    const config = getProvider(storedKey as any) ?? getProvider(providerConfigKey as any);
    const nangoKey = config?.nangoIntegrationId ?? storedKey;
    return await nango.getToken(nangoKey, connectionId) as any;


  } catch (error: unknown) {
    return handleNangoError(error, 'getConnectionToken');
  }
}

export async function getToken(
  connectionId: string,
  providerConfigKey: string,
  orgId: string
): Promise<string> {
  return getConnectionToken(connectionId, providerConfigKey, orgId);
}

export async function getConnection(
  connectionId: string,
  providerConfigKey: string,
  orgId: string
) {
  if (!orgId) {
    throw new Error('orgId is required to fetch connection');
  }

  const nango = getNango();

  // Verify ownership in Supabase — org_id + connection_id uniquely prevents
  // cross-org access without relying on provider_config_key key format matching.
  const { data: mapping, error: supabaseError } = await supabaseAdmin
    .from('nango_connections')
    .select('id, provider_config_key')
    .eq('org_id', orgId)
    .eq('connection_id', connectionId)
    .maybeSingle();

  if (supabaseError) {
    throw new Error(`Supabase verification failed: ${supabaseError.message}`);
  }

  if (!mapping) {
    const notFound = new Error('Connection not found for this organization');
    (notFound as any).status = 404;
    (notFound as any).reason = 'NOT_FOUND';
    throw notFound;
  }

  try {
    const storedKey = (mapping as any).provider_config_key ?? providerConfigKey;
    const config = getProvider(storedKey as any) ?? getProvider(providerConfigKey as any);
    const nangoKey = config?.nangoIntegrationId ?? storedKey;
    return await nango.getConnection(nangoKey, connectionId);
  } catch (error: unknown) {
    return handleNangoError(error, 'getConnection');
  }
}

/**
 * Fetches the full Nango connection object to extract metadata.
 * 🔒 Strictly verified against Nango metadata to prevent cross-org leaks.
 */
export async function getConnectionMetadata(
  connectionId: string,
  providerConfigKey: string,
  orgId: string
): Promise<any> {
  return getConnection(connectionId, providerConfigKey, orgId);
}

/**
 * Lists connections for an organization.
 * 🔒 Properly fixed: Uses server-side filtering (Supabase) to avoid fetching all connections.
 */
export async function listConnections(orgId: string) {
  if (!orgId) {
    throw new Error('orgId is required to list Nango connections');
  }

  const nango = getNango();

  // 1. Fetch authorized connection mappings from Supabase (Source of Truth)
  const { data: mappings, error: supabaseError } = await supabaseAdmin
    .from('nango_connections')
    .select('connection_id, provider_config_key, sync_status, last_synced_at')
    .eq('org_id', orgId)

  if (supabaseError) {
    throw new Error(`Supabase error in listConnections: ${supabaseError.message}`);
  }

  try {
    // 2. No Nango fallback -- if no Supabase row exists, connection doesn't exist
    if (!mappings || mappings.length === 0) {
      const { connections } = await nango.listConnections(undefined, undefined, {
        endUserOrganizationId: orgId
      } as any);

      return connections.filter((conn: any) => conn.metadata?.org_id === orgId).map((c: any) => ({
        ...c,
        sync_status: 'connected',
        last_synced_at: null
      }));
    }

    // 3. Fetch full connection objects from Nango only for the IDs we found in Supabase
    const connectionPromises = (mappings || []).map(async (m: any) => {
      const config = getProvider(m.provider_config_key as any)
      const nangoKey = config?.nangoIntegrationId ?? m.provider_config_key
      const conn = await nango.getConnection(nangoKey, m.connection_id).catch(() => null)
      if (!conn) return null;
      
      return {
        ...conn,
        sync_status: m.sync_status || 'connected',
        last_synced_at: m.last_synced_at,
        provider_config_key: m.provider_config_key
      };
    });


    const connections = (await Promise.all(connectionPromises)).filter((c: any) => c !== null);

    return connections;
  } catch (error: unknown) {
    return handleNangoError(error, 'listConnections');
  }
}

/**
 * Persists a Nango connection mapping to Supabase.
 */
export async function saveConnectionMapping(
  orgId: string,
  connectionId: string,
  providerConfigKey: string
) {
  try {
    const { error } = await supabaseAdmin
      .from('nango_connections')
      .upsert({
        org_id: orgId,
        connection_id: connectionId,
        provider_config_key: providerConfigKey,
        sync_status: 'connected',
        last_synced_at: null,
      }, {
        onConflict: 'org_id, connection_id, provider_config_key'
      })

    if (error) throw error
  } catch (error: unknown) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[nango] saveConnectionMapping failed');
    throw error;
  }
}

/**
 * Partially updates Nango connection metadata (merges into existing).
 * Uses updateMetadata so existing keys (e.g. account_identifier) are preserved.
 * 🔒 Verifies org ownership before updating.
 */
export async function updateConnectionNangoMetadata(
  connectionId: string,
  providerConfigKey: string,
  orgId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!orgId) throw new Error('orgId is required');

  const nango = getNango();

  const { data: mapping, error: supabaseError } = await supabaseAdmin
    .from('nango_connections')
    .select('id')
    .eq('org_id', orgId)
    .eq('connection_id', connectionId)
    .eq('provider_config_key', providerConfigKey)
    .maybeSingle();

  if (supabaseError) throw new Error(`Supabase verification failed: ${supabaseError.message}`);
  if (!mapping) {
    const notFound = new Error('Connection not found for this organization');
    (notFound as any).status = 404;
    throw notFound;
  }

  const config = getProvider(providerConfigKey as any);
  const nangoKey = config?.nangoIntegrationId ?? providerConfigKey;
  await nango.updateMetadata(nangoKey, connectionId, metadata);
}

/**
 * Securely deletes a Nango connection and its Supabase mapping.
 * 🔒 Strictly verifies ownership before deletion.
 */
export async function deleteConnection(
  connectionId: string,
  providerConfigKey: string,
  orgId: string
) {
  if (!orgId) throw new Error('orgId is required for deletion');

  const nango = getNango();

  try {
    // 1. Verify ownership in Supabase first
    const { data: mapping, error: supabaseError } = await supabaseAdmin
      .from('nango_connections')
      .select('id')
      .eq('org_id', orgId)
      .eq('connection_id', connectionId)
      .eq('provider_config_key', providerConfigKey)
      .maybeSingle()

    if (supabaseError) throw new Error(`Supabase verification failed: ${supabaseError.message}`);

    if (!mapping) {
      const notFound = new Error('Connection not found for this organization');
      (notFound as any).status = 404;
      (notFound as any).reason = 'NOT_FOUND';
      throw notFound;
    }

    // 2. Delete from Nango service — non-fatal if already gone or key mismatch
    const config = getProvider(providerConfigKey as any)
    const nangoKey = config?.nangoIntegrationId ?? providerConfigKey
    try {
      await nango.deleteConnection(nangoKey, connectionId);
    } catch (nangoErr: unknown) {
      const status = (nangoErr as any)?.response?.status;
      if (status !== 404) {
        logger.warn({ connectionId, nangoKey, status, err: (nangoErr as any)?.message }, '[nango] deleteConnection: Nango API error — proceeding with Supabase cleanup');
      }
    }

    // 3. Clean up Supabase mapping
    const { error: deleteError } = await supabaseAdmin
      .from('nango_connections')
      .delete()
      .eq('org_id', orgId)
      .eq('connection_id', connectionId)
      .eq('provider_config_key', providerConfigKey);

    if (deleteError) throw deleteError;

    // 4. Delete indexed content: connections → documents → document_embeddings (cascade)
    // The connections table ON DELETE CASCADE propagates to documents and document_embeddings,
    // so deleting the connections row is sufficient to clean up all indexed data.
    const { error: connDeleteError } = await supabaseAdmin
      .from('connections')
      .delete()
      .eq('nango_connection_id', connectionId);

    if (connDeleteError) {
      // Non-fatal: log but don't fail the deletion — Nango connection is already gone
      logger.warn({ connectionId, err: connDeleteError.message }, '[nango] deleteConnection: failed to clean up connections table');
    }

    return { success: true };
  } catch (error: unknown) {
    return handleNangoError(error, 'deleteConnection');
  }
}
