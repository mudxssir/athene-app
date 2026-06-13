// ============================================================
// lib/integrations/calendar-structured.ts — P4-6 (D3 depth)
//
// Shared helpers for the calendar record shape (Google + Microsoft):
//   · structured_fields — attendees / organizer / start-end / recurrence as a
//     structured metadata block (faceted retrieval; no schema migration).
//   · timezone normalization — store UTC + the original tz.
//   · declined/cancelled detection — those events are indexed (history matters)
//     but skipped for LLM extraction.
//   · recurring dedup — keep one instance per series (master/next), dropping the
//     long tail of expanded instances that would otherwise spam the index.
// ============================================================

export interface CalendarAttendee {
  email?: string | null
  displayName?: string | null
  responseStatus?: string | null // accepted | declined | tentative | needsAction
  self?: boolean | null          // true on the connected user's own attendee entry (Google)
}

export interface CalendarStructuredInput {
  start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null
  end?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null
  attendees?: CalendarAttendee[] | null
  organizer?: { email?: string | null; displayName?: string | null } | null
  status?: string | null            // confirmed | tentative | cancelled
  recurringEventId?: string | null  // present on expanded recurring instances
}

export interface CalendarStructuredFields {
  start_utc: string | null
  end_utc: string | null
  start_tz: string | null
  organizer: string | null
  attendees: string[]
  attendee_count: number
  recurring: boolean
  recurring_series_id: string | null
}

/** ISO → UTC ISO (Z). All-day `date` values pass through unchanged. Invalid → null. */
function toUtc(dt?: string | null, date?: string | null): string | null {
  if (date && !dt) return date
  if (!dt) return null
  const d = new Date(dt)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/** Build the structured_fields block for a calendar event. */
export function calendarStructuredFields(ev: CalendarStructuredInput): CalendarStructuredFields {
  const attendees = (ev.attendees ?? [])
    .map((a) => (a.displayName || a.email || '').trim())
    .filter(Boolean)
  return {
    start_utc: toUtc(ev.start?.dateTime, ev.start?.date),
    end_utc: toUtc(ev.end?.dateTime, ev.end?.date),
    start_tz: ev.start?.timeZone ?? null,
    organizer: ev.organizer?.displayName || ev.organizer?.email || null,
    attendees,
    attendee_count: attendees.length,
    recurring: !!ev.recurringEventId,
    recurring_series_id: ev.recurringEventId ?? null,
  }
}

/**
 * Whether an event should be indexed but NOT sent to the LLM extractor:
 * cancelled events, or events the connected user themselves declined. History is
 * kept (the record is still indexed) but spending an LLM call on a dead event is
 * waste.
 *
 * Self-detection: prefer Google's `self: true` attendee flag (no caller wiring
 * needed); fall back to matching `selfEmail` when provided (other providers).
 */
export function isExtractionSkippedEvent(ev: CalendarStructuredInput, selfEmail?: string): boolean {
  if ((ev.status ?? '').toLowerCase() === 'cancelled') return true
  const selfAttendee =
    ev.attendees?.find((a) => a.self === true) ??
    (selfEmail
      ? ev.attendees?.find((a) => (a.email ?? '').toLowerCase() === selfEmail.toLowerCase())
      : undefined)
  if ((selfAttendee?.responseStatus ?? '').toLowerCase() === 'declined') return true
  return false
}

/**
 * Recurring dedup: keep one instance per series — the earliest by start time
 * ("master + next instance" approximation under expanded singleEvents fetches) —
 * plus all non-recurring events. Preserves input order otherwise.
 */
export function dedupRecurring<T extends CalendarStructuredInput>(events: T[]): T[] {
  const earliestBySeries = new Map<string, { idx: number; start: number }>()
  events.forEach((ev, idx) => {
    const series = ev.recurringEventId
    if (!series) return
    const start = new Date(ev.start?.dateTime ?? ev.start?.date ?? 0).getTime()
    const cur = earliestBySeries.get(series)
    if (!cur || start < cur.start) earliestBySeries.set(series, { idx, start })
  })
  const keepIdx = new Set(Array.from(earliestBySeries.values()).map((v) => v.idx))
  return events.filter((ev, idx) => !ev.recurringEventId || keepIdx.has(idx))
}
