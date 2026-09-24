/**
 * Parsing/expansion against the fixture calendar in `tests/fixtures/basic.ics`, covering
 * every case the library spike was chosen against (see the comment at the top of
 * `src/main/integrations/ical/parse.ts`).
 *
 * TZ is pinned to a DST-observing zone, DIFFERENT from every TZID in the fixture, so a bug
 * where an event's own TZID/UTC offset got silently replaced by the host's local zone would
 * show up as a wrong instant regardless of where this suite runs.
 */
process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

if (new Date(2026, 5, 15).getTimezoneOffset() === 0) {
  throw new Error('TZ override did not take effect — tests would be meaningless on UTC')
}

import { parseIcsOccurrences } from '../src/main/integrations/ical/parse'
import { refreshWindow } from '../src/main/integrations/ical/dates'
import { CALENDAR_CACHE_DAYS } from '@shared/types'

const fixture = readFileSync(join(__dirname, 'fixtures/basic.ics'), 'utf8')
const longDaily = readFileSync(join(__dirname, 'fixtures/long-daily.ics'), 'utf8')

// Wide enough to contain every occurrence in the fixture.
const WINDOW_FROM = Date.UTC(2026, 0, 1)
const WINDOW_TO = Date.UTC(2026, 11, 31)

describe('parseIcsOccurrences', () => {
  it('resolves a timed event in a non-UTC TZID using its VTIMEZONE block', () => {
    const events = parseIcsOccurrences(fixture, WINDOW_FROM, WINDOW_TO)
    const event = events.find((e) => e.uid === 'timed-tzid-vtimezone@flowdo-test')
    expect(event).toBeDefined()
    if (!event || event.allDay) throw new Error('expected a timed event')
    // 2026-06-15 09:00 America/New_York is EDT (UTC-4) -> 13:00Z.
    expect(event.startMs).toBe(Date.UTC(2026, 5, 15, 13, 0))
    expect(event.endMs).toBe(Date.UTC(2026, 5, 15, 14, 0))
  })

  it('resolves an IANA TZID with no embedded VTIMEZONE block', () => {
    const events = parseIcsOccurrences(fixture, WINDOW_FROM, WINDOW_TO)
    const event = events.find((e) => e.uid === 'iana-tzid-no-vtimezone@flowdo-test')
    expect(event).toBeDefined()
    if (!event || event.allDay) throw new Error('expected a timed event')
    // 2026-06-20 08:30 Europe/Berlin is CEST (UTC+2) -> 06:30Z.
    expect(event.startMs).toBe(Date.UTC(2026, 5, 20, 6, 30))
  })

  it('passes a UTC (Z) event through unchanged and reports no original time zone', () => {
    const events = parseIcsOccurrences(fixture, WINDOW_FROM, WINDOW_TO)
    const event = events.find((e) => e.uid === 'utc-event@flowdo-test')
    expect(event).toBeDefined()
    if (!event || event.allDay) throw new Error('expected a timed event')
    expect(event.startMs).toBe(Date.UTC(2026, 5, 25, 12, 0))
    expect(event.timeZone).toBeNull()
  })

  it('carries the IANA zone an event was defined in', () => {
    const events = parseIcsOccurrences(fixture, WINDOW_FROM, WINDOW_TO)
    const event = events.find((e) => e.uid === 'tehran-tzid@flowdo-test')
    expect(event).toBeDefined()
    if (!event || event.allDay) throw new Error('expected a timed event')
    // 2026-06-18 10:00 Asia/Tehran (UTC+03:30, no DST since 2022) -> 06:30Z.
    expect(event.startMs).toBe(Date.UTC(2026, 5, 18, 6, 30))
    expect(event.timeZone).toBe('Asia/Tehran')
  })

  it('expands a weekly RRULE, drops the EXDATE, moves the override, drops the cancelled one', () => {
    const events = parseIcsOccurrences(fixture, WINDOW_FROM, WINDOW_TO)
    const weekly = events
      .filter((e) => e.uid === 'weekly-with-exdate-and-override@flowdo-test')
      .filter((e): e is Extract<typeof e, { allDay: false }> => !e.allDay)
      .sort((a, b) => a.startMs - b.startMs)

    // 6 in the RRULE (COUNT=6), minus 1 EXDATE, minus 1 CANCELLED override = 4.
    expect(weekly).toHaveLength(4)

    const starts = weekly.map((e) => e.startMs)
    // The EXDATE'd 2026-06-08 occurrence must be entirely absent.
    expect(starts).not.toContain(Date.UTC(2026, 5, 8, 18, 0))
    // The cancelled 2026-06-22 occurrence, at its ORIGINAL time, must also be absent.
    expect(starts).not.toContain(Date.UTC(2026, 5, 22, 18, 0))

    // The moved override appears at its NEW time (16:30 EDT = 20:30Z), not the original slot.
    const moved = weekly.find((e) => e.title === 'Weekly standup (moved)')
    expect(moved).toBeDefined()
    expect(moved?.startMs).toBe(Date.UTC(2026, 5, 15, 20, 30))
    expect(starts).not.toContain(Date.UTC(2026, 5, 15, 18, 0))

    // Untouched instances keep the master's title and original weekly time (14:00 EDT = 18:00Z).
    const plain = weekly.filter((e) => e.title === 'Weekly standup')
    expect(plain.map((e) => e.startMs).sort()).toEqual(
      [Date.UTC(2026, 5, 1, 18, 0), Date.UTC(2026, 5, 29, 18, 0), Date.UTC(2026, 6, 6, 18, 0)].sort()
    )
  })

  it('represents a single all-day event as calendar days with an exclusive end', () => {
    const events = parseIcsOccurrences(fixture, WINDOW_FROM, WINDOW_TO)
    const event = events.find((e) => e.uid === 'allday-single@flowdo-test')
    expect(event).toBeDefined()
    if (!event || !event.allDay) throw new Error('expected an all-day event')
    expect(event.startDate).toBe('2026-06-03')
    expect(event.endDate).toBe('2026-06-04')
  })

  it('represents a multi-day all-day event with an exclusive end past the last day', () => {
    const events = parseIcsOccurrences(fixture, WINDOW_FROM, WINDOW_TO)
    const event = events.find((e) => e.uid === 'allday-multiday@flowdo-test')
    expect(event).toBeDefined()
    if (!event || !event.allDay) throw new Error('expected an all-day event')
    expect(event.startDate).toBe('2026-06-10')
    expect(event.endDate).toBe('2026-06-13')
  })

  it('throws a plain error on input that is not a calendar at all', () => {
    expect(() => parseIcsOccurrences('not an ics file', WINDOW_FROM, WINDOW_TO)).toThrow()
  })

  it('only returns occurrences overlapping the requested window', () => {
    const farFuture = Date.UTC(2030, 0, 1)
    const events = parseIcsOccurrences(fixture, farFuture, farFuture + 86_400_000)
    expect(events).toHaveLength(0)
  })

  it('expands a long-running daily RRULE over the widened cache window quickly', () => {
    // The rule has recurred daily since 2020 with no COUNT/UNTIL — expansion cost must come
    // from the requested window, not from how far back DTSTART is, or this gets slower every
    // year the feed stays subscribed.
    const now = Date.UTC(2026, 5, 1)
    const { fromMs, toMs } = refreshWindow(now)

    const startedAt = performance.now()
    const events = parseIcsOccurrences(longDaily, fromMs, toMs)
    const elapsedMs = performance.now() - startedAt

    expect(elapsedMs).toBeLessThan(1000)
    // One occurrence per local day in [today - past, today + future], inclusive of today.
    expect(events).toHaveLength(CALENDAR_CACHE_DAYS.past + CALENDAR_CACHE_DAYS.future + 1)
  })
})
