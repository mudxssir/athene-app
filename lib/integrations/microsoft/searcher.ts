import { graphFetch } from './graph-client'
import { FetchedChunk } from '../base'
import { logger } from '@/lib/logger'

/**
 * Searches across Microsoft 365 (Outlook and Calendar).
 */
export async function microsoftSearch(connectionId: string, orgId: string, query: string): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []

  try {
    // 1. Search Emails
    const emailData = await graphFetch(connectionId, orgId, `/me/messages?$search="${query}"&$top=10&$select=subject,from,receivedDateTime,bodyPreview,webLink`)
    if (emailData.value) {
      for (const email of emailData.value) {
        chunks.push({
          chunk_id: `ms_email_${email.id}`,
          title: `Email: ${email.subject}`,
          content: `From: ${email.from?.emailAddress?.name || 'Unknown'}\nDate: ${email.receivedDateTime}\n\n${email.bodyPreview}`,
          source_url: email.webLink,
          shape: 'email' as const,
          metadata: {
            provider: 'microsoft',
            resource_type: 'email',
            id: email.id
          }
        })
      }
    }

    // 2. Search Calendar Events
    const escapedQuery = query.replace(/'/g, "''")
    const eventData = await graphFetch(connectionId, orgId, `/me/events?$filter=contains(subject, '${escapedQuery}')&$top=10&$select=subject,start,end,location,bodyPreview,webLink`)
    if (eventData.value) {
      for (const event of eventData.value) {
        chunks.push({
          chunk_id: `ms_event_${event.id}`,
          title: `Event: ${event.subject}`,
          content: `Time: ${event.start?.dateTime} to ${event.end?.dateTime}\nLocation: ${event.location?.displayName || 'N/A'}\n\n${event.bodyPreview || ''}`,
          source_url: event.webLink,
          shape: 'record' as const,
          metadata: {
            provider: 'microsoft',
            resource_type: 'event',
            id: event.id
          }
        })
      }
    }
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Error in microsoftSearch:')
  }

  return chunks
}
