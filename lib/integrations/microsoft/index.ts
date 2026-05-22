import { fetchUnreadEmails, fetchEmailBody, type OutlookEmail } from './outlook-fetcher'
import { fetchEvents } from './calendar-fetcher'
import { listOneDriveDocs, fetchOneDriveDocContent } from './onedrive-fetcher'
import { listSharePointDocs, fetchDocContent as fetchSharePointDocContent } from './sharepoint-fetcher'
import { FetchedChunk } from '../base'
import { microsoftSearch } from './searcher'
import { graphFetch } from './graph-client'
import { logger } from '@/lib/logger'
import { type SyncConfig, getSelectedResourceIds } from '../sync-config'

// ─── Email chunking constants ────────────────────────────────────────────────
const EMAIL_CHUNK_SIZE = 2000
const EMAIL_CHUNK_OVERLAP = 200

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
              `/me/mailFolders/${folderId}/messages?$filter=isRead eq false&$top=50&$select=subject,from,receivedDateTime,bodyPreview,webLink`
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
          try {
            const rawBody = await fetchEmailBody(connectionId, orgId, email.id)
            // Graph API returns body as HTML for most emails
            const body = stripOutlookHtml(rawBody)
            const from = email.from?.emailAddress?.name ?? email.from?.emailAddress?.address ?? 'Unknown'
            const prefix = [
              `From: ${from}`,
              `Subject: ${email.subject ?? '(no subject)'}`,
              `Date: ${email.receivedDateTime ?? ''}`,
            ].join('\n') + '\n\n'

            const fullText = prefix + body
            let offset = 0
            let idx = 0
            while (offset < fullText.length) {
              const slice = fullText.slice(offset, offset + EMAIL_CHUNK_SIZE)
              emailChunks.push({
                chunk_id: `ms_email_${email.id}:${idx}`,
                title: `Email: ${email.subject ?? '(no subject)'}`,
                content: slice,
                source_url: email.webLink,
                metadata: {
                  provider: 'microsoft',
                  resource_type: 'email',
                  id: email.id,
                  author: from,
                  last_modified: email.receivedDateTime ?? undefined,
                },
              })
              offset += EMAIL_CHUNK_SIZE - EMAIL_CHUNK_OVERLAP
              idx++
            }
          } catch {
            // Fallback to bodyPreview if full body fetch fails
            emailChunks.push({
              chunk_id: `ms_email_${email.id}:0`,
              title: `Email: ${email.subject ?? '(no subject)'}`,
              content: `From: ${email.from?.emailAddress?.name ?? 'Unknown'}\n\n${email.bodyPreview ?? ''}`,
              source_url: email.webLink,
              metadata: { provider: 'microsoft', resource_type: 'email', id: email.id },
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

  // 3. OneDrive Documents
  // If selectedIds is non-null, only start traversal from selected folder IDs
  // (browseOneDrive returns drive item IDs). Otherwise fetch from root.
  try {
    const oneDriveSelected = selectedIds
      ? [...selectedIds].filter(id => !id.startsWith('site:'))
      : null

    if (!oneDriveSelected || oneDriveSelected.length > 0) {
      const startIds = oneDriveSelected && oneDriveSelected.length > 0
        ? oneDriveSelected
        : ['root']

      for (const startId of startIds) {
        const driveDocs = await listOneDriveDocs(connectionId, orgId, startId === 'root' ? undefined : startId)
        for (const doc of driveDocs) {
          const content = await fetchOneDriveDocContent(connectionId, orgId, doc.id)
          chunks.push({
            chunk_id: `ms_drive_${doc.id}`,
            title: `OneDrive: ${doc.name}`,
            content,
            source_url: doc.webLink,
            metadata: {
              provider: 'microsoft',
              resource_type: 'onedrive_doc',
              id: doc.id
            }
          })
        }
      }
    }
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
      for (const site of sitesData.value) {
        // Skip sites not in selection — unless we have drive-level selections (need to visit all sites)
        if (selectedIds && selectedIds.size > 0 && !hasDriveOnlySelection) {
          const siteSelected = selectedIds.has(`site:${site.id}`) || selectedIds.has(site.id)
          if (!siteSelected) continue
        }

        try {
          const siteDocs = await listSharePointDocs(connectionId, orgId, site.id)
          for (const doc of siteDocs) {
            const driveId = doc.parentReference?.driveId
            if (!driveId) continue
            // Per-doc drive filter: skip if user made a selection but this drive isn't in it.
            // A whole-site selection ("site:ID") passes all docs in that site.
            // An item: selection (subfolder drill-down) is scoped by the driveId embedded in its prefix.
            const hasItemSelectionForDrive = selectedItemIds && selectedItemIds.length > 0
              && selectedItemIds.some(itemId => itemId.startsWith(`item:${driveId}:`))
            if (selectedIds && selectedIds.size > 0 &&
                !selectedIds.has(`site:${site.id}`) &&
                !selectedIds.has(`drive:${driveId}`) &&
                !hasItemSelectionForDrive) {
              continue
            }
            const content = await fetchSharePointDocContent(connectionId, orgId, driveId, doc.id)
            chunks.push({
              chunk_id: `ms_sharepoint_${doc.id}`,
              title: `SharePoint: ${doc.name}`,
              content,
              source_url: doc.webLink,
              metadata: {
                provider: 'microsoft',
                resource_type: 'sharepoint_doc',
                id: doc.id
              }
            })
          }
        } catch (siteError) {
          logger.error({ siteId: site.id, err: siteError instanceof Error ? siteError.message : String(siteError) }, '[microsoft] Error fetching docs for SharePoint site');
        }
      }
    }
  } catch (error) {
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[microsoft] Error fetching SharePoint docs');
  }

  return chunks
}

