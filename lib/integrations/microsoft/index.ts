import { fetchUnreadEmails, fetchEmailBody, formatRecipients, OUTLOOK_EMAIL_SELECT, type OutlookEmail } from './outlook-fetcher'
import { fetchEvents } from './calendar-fetcher'
import { listOneDriveDocs, fetchOneDriveDocContent } from './onedrive-fetcher'
import { listSharePointDocs, fetchDocContent as fetchSharePointDocContent } from './sharepoint-fetcher'
import { FetchedChunk } from '../base'
import { microsoftSearch } from './searcher'
import { graphFetch } from './graph-client'
import { logger } from '@/lib/logger'
import { type SyncConfig, getSelectedResourceIds } from '../sync-config'
import { tabularChunksFromParsed } from '@/lib/integrations/tabular-analysis'
import { buildEmailChunks } from '@/lib/integrations/email-clean'

/** Strip HTML tags so raw body content is plain text for embeddings. */
function stripOutlookHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function microsoftFetcher(
  connectionId: string,
  orgId: string,
  options?: { syncConfig?: SyncConfig }
): Promise<FetchedChunk[]> {
  const chunks: FetchedChunk[] = []

  // browseOneDrive/browseSharePoint store item/site IDs as resource IDs.
  // If the user selected specific folders/sites, scope fetching to those.
  const selectedIds = options?.syncConfig
    ? getSelectedResourceIds(options.syncConfig)
    : null

  // Separate selected IDs by type so each section can scope independently.
  // browseOutlook returns mail folder IDs, browseMsCalendar returns calendar IDs,
  // browseOneDrive returns drive item IDs, browseSharePoint returns site:/drive:/item: prefixed IDs.
  const selectedFolderIds = selectedIds
    ? [...selectedIds].filter(id =>
        !id.startsWith('site:') && !id.startsWith('drive:') && !id.startsWith('item:'))
    : null
  // item:{driveId}:{itemId} — SharePoint subfolder selections from browseSharePoint drill-down.
  // These must NOT flow into email/calendar sections (they are not folder GUIDs).
  const selectedItemIds = selectedIds
    ? [...selectedIds].filter(id => id.startsWith('item:'))
    : null
  // Only consider IDs that look like mail folder IDs (non-prefixed GUIDs) for email filtering.
  // Calendar IDs also look like GUIDs but are used in section 2 below.

  // 1. Outlook Emails — full body indexing with overlap-chunking
  // If mail folder IDs were selected (from browseOutlook), fetch from each folder.
  // Otherwise fall back to /me/messages (all recent unread).
  try {
    const emails = selectedFolderIds && selectedFolderIds.length > 0
      ? (await Promise.all(
          selectedFolderIds.map(folderId =>
            graphFetch(connectionId, orgId,
              `/me/mailFolders/${folderId}/messages?$filter=isRead eq false&$top=50&$select=${OUTLOOK_EMAIL_SELECT}`
            ).then(r => r.value ?? []).catch(() => [])
          )
        )).flat() as OutlookEmail[]
      : await fetchUnreadEmails(connectionId, orgId, 100)

    // ATH-B0: Process in small parallel batches to avoid rate limits
    const BATCH = 5
    for (let i = 0; i < emails.length; i += BATCH) {
      const batch = emails.slice(i, i + BATCH)
      const results = await Promise.all(
        batch.map(async (email: OutlookEmail) => {
          const emailChunks: FetchedChunk[] = []
          const from = email.from?.emailAddress?.name ?? email.from?.emailAddress?.address ?? 'Unknown'
          // D4 (P3-5): ONE chunk per email. chunk_id = ms_email_{id} (no :idx);
          // conversationId → thread_id for thread stitching (P3-8). Sub-chunking
          // happens at index time (email shape policy), not by pre-slicing.
          try {
            const rawBody = await fetchEmailBody(connectionId, orgId, email.id)
            // Graph API returns body as HTML for most emails
            const body = stripOutlookHtml(rawBody)
            const to = formatRecipients(email.toRecipients)
            const cc = formatRecipients(email.ccRecipients)
            const prefix = [
              `From: ${from}`,
              to ? `To: ${to}` : null,
              cc ? `Cc: ${cc}` : null,
              `Subject: ${email.subject ?? '(no subject)'}`,
              `Date: ${email.receivedDateTime ?? ''}`,
            ].filter(Boolean).join('\n') + '\n\n'

            // P3-6: Talon cleaning — embed the reply, keep the quoted tail as a
            // non-embedded provenance chunk. Fails open to the full body.
            const built = await buildEmailChunks(
              {
                chunk_id: `ms_email_${email.id}`,
                title: `Email: ${email.subject ?? '(no subject)'}`,
                source_url: email.webLink,
                shape: 'email' as const,
                metadata: {
                  provider: 'microsoft',
                  resource_type: 'email',
                  id: email.id,
                  author: from,
                  last_modified: email.receivedDateTime ?? undefined,
                  thread_id: email.conversationId ?? undefined,
                },
              },
              prefix,
              body,
              email.from?.emailAddress?.address ?? undefined,
            )
            emailChunks.push(...built)
          } catch {
            // Fallback to bodyPreview if full body fetch fails
            emailChunks.push({
              chunk_id: `ms_email_${email.id}`,
              title: `Email: ${email.subject ?? '(no subject)'}`,
              content: `From: ${from}\n\n${email.bodyPreview ?? ''}`,
              source_url: email.webLink,
              shape: 'email' as const,
              metadata: {
                provider: 'microsoft',
                resource_type: 'email',
                id: email.id,
                thread_id: email.conversationId ?? undefined,
              },
            })
          }
          return emailChunks
        })
      )
      for (const r of results) chunks.push(...r)
    }
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[microsoft] Error fetching Outlook emails');
  }

  // 2. Calendar Events — enriched with attendees and organizer
  // browseMsCalendar returns calendar IDs. Fetch per-calendar if selected,
  // otherwise fall back to /me/calendarView (default calendar).
  try {
    const now = new Date()
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

    // If calendar IDs are selected, fetch from each. Graph calendarView endpoint
    // supports /me/calendars/{id}/calendarView for per-calendar queries.
    const calendarIdsToFetch = selectedFolderIds && selectedFolderIds.length > 0
      ? selectedFolderIds
      : null

    const eventPages = calendarIdsToFetch
      ? await Promise.all(
          calendarIdsToFetch.map(calId =>
            graphFetch(connectionId, orgId,
              `/me/calendars/${calId}/calendarView?startDateTime=${now.toISOString()}&endDateTime=${nextWeek.toISOString()}`
            ).then(r => r.value ?? []).catch(() => [])
          )
        ).then(pages => pages.flat())
      : await fetchEvents(connectionId, orgId, now, nextWeek).then(r => r.value ?? [])

    for (const event of eventPages) {
        const organizer = event.organizer?.emailAddress?.name ?? event.organizer?.emailAddress?.address
        const attendeeNames: string[] = (event.attendees ?? [])
          .map((a: any) => a.emailAddress?.name ?? a.emailAddress?.address)
          .filter(Boolean)

        const lines: string[] = [
          `Event: ${event.subject}`,
          `Start: ${event.start?.dateTime}`,
          `End: ${event.end?.dateTime}`,
        ]
        if (organizer) lines.push(`Organizer: ${organizer}`)
        if (attendeeNames.length > 0) lines.push(`Attendees: ${attendeeNames.join(', ')}`)
        if (event.location?.displayName) lines.push(`Location: ${event.location.displayName}`)
        if (event.bodyPreview) lines.push(`\n${event.bodyPreview}`)

        chunks.push({
          chunk_id: `ms_event_${event.id}`,
          title: `Event: ${event.subject}`,
          content: lines.join('\n'),
          source_url: event.webLink,
          shape: 'record' as const,
          metadata: {
            provider: 'microsoft',
            resource_type: 'event',
            id: event.id,
          },
        })
      }
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[microsoft] Error fetching Calendar events');
  }

  // 3. OneDrive Documents — scoped to selected folders when syncConfig provides them
  try {
    const driveDocs = await listOneDriveDocs(connectionId, orgId, options?.syncConfig)
    const driveChunkArrays = await Promise.all(driveDocs.map(async (doc) => {
      const { text, tables, parser_used } = await fetchOneDriveDocContent(connectionId, orgId, doc.id)
      const sourceUrl = doc.webLink
      const docChunks: FetchedChunk[] = []
      // Table chunks (Hebbia-style structured extraction)
      if (tables.length > 0) {
        const tableChunks = await tabularChunksFromParsed(
          tables,
          `ms_drive_${doc.id}`,
          `OneDrive: ${doc.name}`,
          sourceUrl,
          { withLlmAnalysis: false, provider: 'onedrive_tabular' },
        )
        if (parser_used) for (const c of tableChunks) c.metadata.parser_used = parser_used
        docChunks.push(...tableChunks)
      }
      // Narrative text chunk
      if (text.trim().length > 0) {
        docChunks.push({
          chunk_id: `ms_drive_${doc.id}`,
          title: `OneDrive: ${doc.name}`,
          content: text,
          source_url: sourceUrl,
          shape: 'prose' as const,
          metadata: { provider: 'microsoft', resource_type: 'onedrive_doc', id: doc.id, ...(parser_used ? { parser_used } : {}) },
        } satisfies FetchedChunk)
      }
      return docChunks
    }))
    for (const docChunks of driveChunkArrays) chunks.push(...docChunks)
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[microsoft] Error fetching OneDrive docs');
  }

  // 4. SharePoint Documents
  // browseSharePoint returns IDs prefixed with "site:${siteId}" and "drive:${driveId}".
  // Site-gate: include a site if:
  //   - no selection (sync all), OR
  //   - user selected the whole site ("site:ID"), OR
  //   - user selected any drive-level resource (drive:*) — we can't pre-determine which
  //     site a drive belongs to without extra API calls, so we let all sites through and
  //     rely on the per-doc drive filter to exclude unselected drives.
  try {
    const hasDriveOnlySelection = selectedIds && selectedIds.size > 0 &&
      [...selectedIds].every(id => id.startsWith('drive:'))

    const sitesData = await graphFetch(connectionId, orgId, '/sites?search=*')
    if (sitesData.value) {
      // Fetch all sites in parallel — independent per-site calls
      const siteChunks = await Promise.allSettled(
        sitesData.value
          .filter((site: any) => {
            // Skip sites not in selection — unless we have drive-level selections (need to visit all sites)
            if (selectedIds && selectedIds.size > 0 && !hasDriveOnlySelection) {
              return selectedIds.has(`site:${site.id}`) || selectedIds.has(site.id)
            }
            return true
          })
          .map(async (site: any) => {
            const siteDocs = await listSharePointDocs(connectionId, orgId, site.id)
            // Fetch all docs within the site in parallel — independent per-doc calls
            return Promise.allSettled(
              siteDocs
                .filter((doc: any) => {
                  const driveId = doc.parentReference?.driveId
                  if (!driveId) return false
                  const hasItemSelectionForDrive = selectedItemIds && selectedItemIds.length > 0
                    && selectedItemIds.some((itemId: string) => itemId.startsWith(`item:${driveId}:`))
                  if (selectedIds && selectedIds.size > 0 &&
                      !selectedIds.has(`site:${site.id}`) &&
                      !selectedIds.has(`drive:${driveId}`) &&
                      !hasItemSelectionForDrive) {
                    return false
                  }
                  return true
                })
                .map(async (doc: any) => {
                  const driveId = doc.parentReference.driveId
                  const { text, tables, parser_used } = await fetchSharePointDocContent(connectionId, orgId, driveId, doc.id)
                  const sourceUrl = doc.webLink
                  const docChunks: FetchedChunk[] = []
                  if (tables.length > 0) {
                    const tableChunks = await tabularChunksFromParsed(
                      tables,
                      `ms_sharepoint_${doc.id}`,
                      `SharePoint: ${doc.name}`,
                      sourceUrl,
                      { withLlmAnalysis: false, provider: 'sharepoint_tabular' },
                    )
                    if (parser_used) for (const c of tableChunks) c.metadata.parser_used = parser_used
                    docChunks.push(...tableChunks)
                  }
                  if (text.trim().length > 0) {
                    docChunks.push({
                      chunk_id: `ms_sharepoint_${doc.id}`,
                      title: `SharePoint: ${doc.name}`,
                      content: text,
                      source_url: sourceUrl,
                      shape: 'prose' as const,
                      metadata: { provider: 'microsoft', resource_type: 'sharepoint_doc', id: doc.id, ...(parser_used ? { parser_used } : {}) },
                    } satisfies FetchedChunk)
                  }
                  return docChunks
                })
            )
          })
      )

      for (const siteResult of siteChunks) {
        if (siteResult.status === 'rejected') {
          logger.error({ err: siteResult.reason instanceof Error ? siteResult.reason.message : String(siteResult.reason) }, '[microsoft] Error fetching SharePoint site docs')
          continue
        }
        for (const docResult of siteResult.value) {
          if (docResult.status === 'fulfilled') {
            chunks.push(...docResult.value)
          } else {
            logger.warn({ err: docResult.reason instanceof Error ? docResult.reason.message : String(docResult.reason) }, '[microsoft] Error fetching SharePoint doc — skipping')
          }
        }
      }
    }
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[microsoft] Error fetching SharePoint docs');
  }

  return chunks
}

