import { getConnection } from '@/lib/nango/client'
import { baseFetch, getProviderToken } from '../base'

export async function snowflakeFetch(connectionId: string, orgId: string, sql: string, binds?: string[]): Promise<any> {
  const token = await getProviderToken(connectionId, 'snowflake', orgId)
  const connection = await getConnection(connectionId, 'snowflake', orgId)
  
  const accountIdentifier = connection.metadata?.account_identifier
  if (!accountIdentifier) {
    throw new Error('Snowflake account identifier not found in connection metadata. Please ensure it is configured in Nango.')
  }

  return baseFetch(`https://${accountIdentifier}.snowflakecomputing.com/api/v2/statements`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
      'Accept': 'application/json'
    },
    body: {
      statement: sql,
      timeout: 30,
      ...(binds && binds.length > 0 ? { binds } : {})
    }
  })
}
