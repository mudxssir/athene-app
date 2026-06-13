// ============================================================
// lib/integrations/__tests__/calendar-structured.test.ts — P4-6 (D3 depth)
//
// structured_fields, UTC/tz normalization, declined/cancelled extraction-skip,
// and recurring dedup for the calendar record shape.
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  calendarStructuredFields,
  isExtractionSkippedEvent,
  dedupRecurring,
} from '@/lib/integrations/calendar-structured'

describe('calendarStructuredFields (P4-6)', () => {
  it('normalizes start/end to UTC and keeps the original tz', () => {
    const f = calendarStructuredFields({
      start: { dateTime: '2026-06-01T09:00:00-04:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-06-01T10:00:00-04:00', timeZone: 'America/New_York' },
      organizer: { displayName: 'Dana Lee', email: 'dana@acme.com' },
      attendees: [
        { displayName: 'Bob', email: 'bob@acme.com', responseStatus: 'accepted' },
        { email: 'carol@acme.com', responseStatus: 'tentative' },
      ],
    })
    expect(f.start_utc).toBe('2026-06-01T13:00:00.000Z') // -04:00 → UTC
    expect(f.start_tz).toBe('America/New_York')
    expect(f.organizer).toBe('Dana Lee')
    expect(f.attendees).toEqual(['Bob', 'carol@acme.com'])
    expect(f.attendee_count).toBe(2)
    expect(f.recurring).toBe(false)
  })

  it('marks recurring instances with the series id', () => {
    const f = calendarStructuredFields({
      start: { dateTime: '2026-06-01T09:00:00Z' },
      end: { dateTime: '2026-06-01T10:00:00Z' },
      recurringEventId: 'series-abc',
    })
    expect(f.recurring).toBe(true)
    expect(f.recurring_series_id).toBe('series-abc')
  })

  it('passes all-day date values through and tolerates missing fields', () => {
    const f = calendarStructuredFields({ start: { date: '2026-06-01' }, end: { date: '2026-06-02' } })
    expect(f.start_utc).toBe('2026-06-01')
    expect(f.attendees).toEqual([])
    expect(f.organizer).toBeNull()
  })
})

describe('isExtractionSkippedEvent (P4-6)', () => {
  it('skips cancelled events', () => {
    expect(isExtractionSkippedEvent({ status: 'cancelled' })).toBe(true)
  })

  it('skips events the user themselves declined', () => {
    const ev = { status: 'confirmed', attendees: [{ email: 'me@acme.com', responseStatus: 'declined' }] }
    expect(isExtractionSkippedEvent(ev, 'me@acme.com')).toBe(true)
  })

  it('does not skip confirmed events the user accepted', () => {
    const ev = { status: 'confirmed', attendees: [{ email: 'me@acme.com', responseStatus: 'accepted' }] }
    expect(isExtractionSkippedEvent(ev, 'me@acme.com')).toBe(false)
    expect(isExtractionSkippedEvent({ status: 'confirmed' })).toBe(false)
  })
})

describe('dedupRecurring (P4-6)', () => {
  it('keeps one (earliest) instance per recurring series, all non-recurring events', () => {
    const events = [
      { start: { dateTime: '2026-06-03T09:00:00Z' }, recurringEventId: 'S1' }, // later S1
      { start: { dateTime: '2026-06-01T09:00:00Z' }, recurringEventId: 'S1' }, // earliest S1 → keep
      { start: { dateTime: '2026-06-02T09:00:00Z' } },                          // one-off → keep
      { start: { dateTime: '2026-06-05T09:00:00Z' }, recurringEventId: 'S2' }, // only S2 → keep
    ]
    const out = dedupRecurring(events)
    expect(out).toHaveLength(3)
    // The kept S1 is the earliest one.
    const s1 = out.filter((e) => e.recurringEventId === 'S1')
    expect(s1).toHaveLength(1)
    expect(s1[0].start!.dateTime).toBe('2026-06-01T09:00:00Z')
    // The one-off survived.
    expect(out.some((e) => !e.recurringEventId)).toBe(true)
  })

  it('no-op when there are no recurring events', () => {
    const events = [{ start: { dateTime: '2026-06-01T09:00:00Z' } }]
    expect(dedupRecurring(events)).toHaveLength(1)
  })
})
