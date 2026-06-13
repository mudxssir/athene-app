import { googleFetch } from './api-client'
import type { FetchedChunk } from '@/lib/integrations/base'
import { assertSafeMetadata } from '@/lib/integrations/base'
import { type SyncConfig, getSelectedResourceIds } from '@/lib/integrations/sync-config'
import { calendarStructuredFields, isExtractionSkippedEvent, dedupRecurring } from '@/lib/integrations/calendar-structured'
import { logger } from '@/lib/logger'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  location?: string
  start: { dateTime?: string; date?: string; timeZone?: string }
  end: { dateTime?: string; date?: string; timeZone?: string }
  attendees?: Array<{
    email: string
    displayName?: string
    responseStatus?: string
    self?: boolean
  }>
  organizer?: { email: string; displayName?: string }
  htmlLink?: string
  status?: string
  created?: string
  updated?: string
  /** Present on expanded recurring instances (points at the series master). */
  recurringEventId?: string
}

export interface CalendarListResponse {
  items: CalendarEvent[]
  nextPageToken?: string
}

export interface EventDraft {
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: Array<{ email: string }>
}

// ─── Event Listing ───────────────────────────────────────────────────────────

/**
 * Fetches calendar events within a given time window from the user's primary calendar.
 */
export async function fetchCalendarEvents(
  connectionId: string,
  orgId: string,
  timeMin: Date,
  timeMax: Date,
  maxResults: number = 50,
  calendarId: string = 'primary'
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  })

  const encodedId = encodeURIComponent(calendarId)
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params.toString()}`
  const res = await googleFetch<CalendarListResponse>(connectionId, orgId, url)
  return res.items || []
}

/**
 * Fetches today's remaining events from the primary calendar.
 */
export async function fetchTodayEvents(
  connectionId: string,
  orgId: string
): Promise<CalendarEvent[]> {
  const now = new Date()
  const endOfDay = new Date(now)
  endOfDay.setHours(23, 59, 59, 999)
  return fetchCalendarEvents(connectionId, orgId, now, endOfDay)
}

/**
 * Fetches events for the upcoming week.
 */
export async function fetchWeekEvents(
  connectionId: string,
  orgId: string
): Promise<CalendarEvent[]> {
  const now = new Date()
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + 7)
  return fetchCalendarEvents(connectionId, orgId, now, nextWeek)
}

// ─── Event Creation ──────────────────────────────────────────────────────────

/**
 * Creates a new event on the user's primary Google Calendar.
 */
export async function createCalendarEvent(
  connectionId: string,
  orgId: string,
  event: EventDraft
): Promise<CalendarEvent> {
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
  return googleFetch<CalendarEvent>(connectionId, orgId, url, {
    method: 'POST',
    body: event,
  })
}

// ─── Event Modification ──────────────────────────────────────────────────────

/**
 * Updates an existing event on the user's primary Google Calendar.
 */
export async function updateCalendarEvent(
  connectionId: string,
  orgId: string,
  eventId: string,
  updates: Partial<EventDraft>
): Promise<CalendarEvent> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`
  return googleFetch<CalendarEvent>(connectionId, orgId, url, {
    method: 'PATCH',
    body: updates,
  })
}

/**
 * Deletes an event from the user's primary Google Calendar.
 */
export async function deleteCalendarEvent(
  connectionId: string,
  orgId: string,
  eventId: string
): Promise<void> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`
  await googleFetch(connectionId, orgId, url, { method: 'DELETE' })
}

// ─── FetchedChunk Builders ──────────────────────────────────────────────────

/**
 * Converts a CalendarEvent into a FetchedChunk for the indexing pipeline
 * or the agent's response formatter.
 *
 * Content is a human-readable summary of the event details.
 *
 * @param event - The CalendarEvent from fetchCalendarEvents.
 * @returns A FetchedChunk that can be passed to indexDocument.
 */
export function calendarEventToChunk(event: CalendarEvent): FetchedChunk {
  const startTime = event.start.dateTime || event.start.date || 'unknown'
  const endTime = event.end.dateTime || event.end.date || 'unknown'
  const attendeeList = event.attendees
    ?.map(a => a.displayName || a.email)
    .join(', ') || 'none'

  const content = [
    `Event: ${event.summary}`,
    `When: ${startTime} → ${endTime}`,
    event.location ? `Where: ${event.location}` : null,
    event.description ? `Description: ${event.description}` : null,
    `Attendees: ${attendeeList}`,
    event.organizer ? `Organizer: ${event.organizer.displayName || event.organizer.email}` : null,
    event.status ? `Status: ${event.status}` : null,
  ].filter(Boolean).join('\n')

  // P4-6 (D3 depth): structured_fields block (attendees/organizer/start-end UTC +
  // tz/recurrence) for faceted retrieval; skip_extraction marks cancelled/declined
  // events so they are indexed (history) but never sent to the LLM extractor.
  const metadata: FetchedChunk['metadata'] = {
    provider: 'google',
    resource_type: 'calendar_event',
    last_modified: event.updated || event.created,
    author: event.organizer?.displayName || event.organizer?.email,
    event_status: event.status,
    structured_fields: calendarStructuredFields(event),
    skip_extraction: isExtractionSkippedEvent(event),
  }
  assertSafeMetadata(metadata)

  return {
    chunk_id: `calendar:${event.id}`,
    title: event.summary,
    content,
    source_url: event.htmlLink || `https://calendar.google.com/calendar/event?eid=${event.id}`,
    shape: 'record' as const,
    metadata,
  }
}

/**
 * Convenience wrapper: fetches events in a time window and returns FetchedChunk[].
 * This is what the nango-fetch worker calls for Calendar indexing.
 *
 * When syncConfig has selected calendars (from browseGoogleCalendar), fetches
 * events from each selected calendar instead of only the primary one.
 */
export async function fetchCalendarChunks(
  connectionId: string,
  orgId: string,
  timeMin: Date,
  timeMax: Date,
  syncConfig?: SyncConfig,
): Promise<FetchedChunk[]> {
  const selectedCalendarIds = syncConfig ? getSelectedResourceIds(syncConfig) : null

  if (!selectedCalendarIds || selectedCalendarIds.size === 0) {
    // Default: primary calendar only. P4-6: dedup expanded recurring instances
    // (singleEvents=true) to master + next per series before chunking.
    const events = dedupRecurring(await fetchCalendarEvents(connectionId, orgId, timeMin, timeMax))
    return events.map(calendarEventToChunk)
  }

  // Fetch events from each selected calendar and merge
  const allChunks: FetchedChunk[] = []
  for (const calId of selectedCalendarIds) {
    try {
      const events = dedupRecurring(await fetchCalendarEvents(connectionId, orgId, timeMin, timeMax, 50, calId))
      allChunks.push(...events.map(calendarEventToChunk))
    } catch (err) {
      logger.warn(
        { calendarId: calId, err: err instanceof Error ? err.message : String(err) },
        '[calendar] Failed to fetch events from selected calendar — skipping'
      )
    }
  }
  return allChunks
}
