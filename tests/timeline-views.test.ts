/**
 * View-mode range computation and bucketing (`components/timeline/views.ts`).
 *
 * Same `process.env.TZ` approach as `tests/timeline-layout.test.ts` — see that file's header
 * for why it's mutated in-process rather than exported from the shell.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CalendarEvent, Session } from '../src/shared/types'
import { localDayBounds, localWeekBounds } from '../src/renderer/src/components/timeline/layout'
import { weekDays } from '../src/renderer/src/components/timeline/layout'
import { formatEventStart, formatWeekHeading } from '../src/renderer/src/components/timeline/format'
import {
  allDayEventSpan,
  allDayEventsForDay,
  bucketSessionsByDay,
  calendarCacheBounds,
  calendarWindowNote,
  focusMsForDay,
  isViewActive,
  limitChips,
  shiftView,
  timedEventsForDay,
  viewRangeBounds,
  VIEW_MODES
} from '../src/renderer/src/components/timeline/views'

let originalTz: string | undefined

beforeEach(() => {
  originalTz = process.env.TZ
  process.env.TZ = 'America/New_York'
})

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 1,
    taskId: null,
    projectId: null,
    mode: 'flowmodoro',
    kind: 'focus',
    startedAt: 0,
    endedAt: 0,
    plannedMs: null,
    actualMs: 0,
    completed: true,
    interrupted: false,
    notes: null,
    ...overrides
  }
}

function timedEvent(overrides: Partial<Extract<CalendarEvent, { allDay: false }>> = {}): CalendarEvent {
  return {
    id: 1,
    feedId: 1,
    title: 'Event',
    location: null,
    allDay: false,
    startMs: 0,
    endMs: 0,
    timeZone: null,
    ...overrides
  }
}

function allDayEvent(
  overrides: Partial<Extract<CalendarEvent, { allDay: true }>> = {}
): Extract<CalendarEvent, { allDay: true }> {
  return {
    id: 1,
    feedId: 1,
    title: 'All-day event',
    location: null,
    allDay: true,
    startDate: '2026-06-01',
    endDate: '2026-06-02',
    ...overrides
  }
}

describe('viewRangeBounds', () => {
  it('day matches localDayBounds', () => {
    const anchor = new Date(2026, 5, 17, 9).getTime()
    expect(viewRangeBounds('day', anchor)).toEqual(localDayBounds(anchor))
  })

  it('week is Monday through the following Monday', () => {
    const anchor = new Date(2026, 5, 17, 9).getTime()
    const { start, end } = viewRangeBounds('week', anchor)
    expect(new Date(start).getDay()).toBe(1)
    expect(end - start).toBe(7 * 24 * 3_600_000)
  })

  it('month spans the full leading/trailing grid, not just the 1st-to-last', () => {
    // Feb 2026 starts on a Sunday: the grid leads with 26-31 January.
    const anchor = new Date(2026, 1, 10).getTime()
    const { start, end } = viewRangeBounds('month', anchor)
    expect(start).toBe(new Date(2026, 0, 26).getTime())
    expect(end).toBe(new Date(2026, 2, 2).getTime())
  })

  it('week starts on Sunday when weekStartsOn=0 is passed through', () => {
    const anchor = new Date(2026, 5, 17, 9).getTime() // Wed 17 June 2026
    const { start, end } = viewRangeBounds('week', anchor, 0)
    expect(new Date(start).getDay()).toBe(0)
    expect(start).toBe(new Date(2026, 5, 14).getTime())
    expect(end - start).toBe(7 * 24 * 3_600_000)
  })

  it('month grid leads on Sunday when weekStartsOn=0 is passed through (Feb 2026 starts Sunday)', () => {
    const anchor = new Date(2026, 1, 10).getTime()
    const { start, end } = viewRangeBounds('month', anchor, 0)
    // Feb 2026 already starts on a Sunday, so with weekStartsOn=0 the grid needs no leading
    // days at all — start is 1 Feb itself, unlike the Monday-start case above.
    expect(start).toBe(new Date(2026, 1, 1).getTime())
    expect(new Date(start).getDay()).toBe(0)
    expect(end).toBe(new Date(2026, 2, 1).getTime())
  })
})

describe('shiftView', () => {
  it('day steps by one calendar day', () => {
    const mar7 = new Date(2026, 2, 7, 12).getTime()
    expect(shiftView('day', mar7, 1)).toBe(new Date(2026, 2, 8, 12).getTime())
  })

  it('week steps by 7 calendar days across the fall-back transition', () => {
    const monday = new Date(2026, 9, 26, 12).getTime()
    expect(shiftView('week', monday, 1)).toBe(new Date(2026, 10, 2, 12).getTime())
  })

  it('month steps by calendar month without day-of-month rollover', () => {
    const jan31 = new Date(2026, 0, 31, 12).getTime()
    expect(shiftView('month', jan31, 1)).toBe(new Date(2026, 1, 1).getTime())
  })

  it('week steps across the fall-back transition and still lands on a Sunday-start week', () => {
    // 25 Oct 2026 is a Sunday, one week before the fall-back day (1 Nov 2026, also a Sunday).
    const sunday = new Date(2026, 9, 25, 12).getTime()
    const next = shiftView('week', sunday, 1)
    expect(new Date(next).getDay()).toBe(0)
    const { start } = localWeekBounds(next, 0)
    expect(new Date(start).getDay()).toBe(0)
    expect(start).toBe(new Date(2026, 10, 1).getTime())
  })
})

describe('bucketSessionsByDay / focusMsForDay', () => {
  it('keys a session by the local day it STARTED, not any part of its span', () => {
    // Starts 23:00 on the 15th, ends 01:00 on the 16th.
    const s = session({
      startedAt: new Date(2026, 5, 15, 23, 0).getTime(),
      endedAt: new Date(2026, 5, 16, 1, 0).getTime(),
      actualMs: 2 * 3_600_000
    })
    const byDay = bucketSessionsByDay([s])
    expect(byDay.has('2026-06-15')).toBe(true)
    expect(byDay.has('2026-06-16')).toBe(false)
  })

  it('sums FOCUS session time for a day, abandoned sessions included', () => {
    const focus = session({ kind: 'focus', actualMs: 20 * 60_000, completed: false })
    const brk = session({ kind: 'short_break', actualMs: 5 * 60_000 })
    expect(focusMsForDay([focus, brk])).toBe(20 * 60_000)
  })
})

describe('timedEventsForDay', () => {
  it('splits an event crossing midnight onto both days it touches, clipped', () => {
    const bounds15 = localDayBounds(new Date(2026, 5, 15, 12).getTime())
    const bounds16 = localDayBounds(new Date(2026, 5, 16, 12).getTime())
    const event = timedEvent({
      startMs: new Date(2026, 5, 15, 22).getTime(),
      endMs: new Date(2026, 5, 16, 2).getTime()
    })

    const day15 = timedEventsForDay([event], bounds15)
    expect(day15).toHaveLength(1)
    expect(day15[0]?.clipped.endMs).toBe(bounds15.end)
    expect(day15[0]?.clipped.continues).toBe(true)
    expect(day15[0]?.continuesFromPrevious).toBe(false)

    const day16 = timedEventsForDay([event], bounds16)
    expect(day16).toHaveLength(1)
    expect(day16[0]?.clipped.startMs).toBe(bounds16.start)
    expect(day16[0]?.continuesFromPrevious).toBe(true)
  })

  it('excludes an event that does not touch the day at all', () => {
    const bounds = localDayBounds(new Date(2026, 5, 20).getTime())
    const event = timedEvent({
      startMs: new Date(2026, 5, 15).getTime(),
      endMs: new Date(2026, 5, 16).getTime()
    })
    expect(timedEventsForDay([event], bounds)).toHaveLength(0)
  })
})

describe('allDayEventsForDay', () => {
  it('shows a multi-day all-day event on every day it covers, end exclusive', () => {
    const event = allDayEvent({ startDate: '2026-06-01', endDate: '2026-06-04' })
    expect(allDayEventsForDay([event], new Date(2026, 5, 1).getTime())).toHaveLength(1)
    expect(allDayEventsForDay([event], new Date(2026, 5, 3).getTime())).toHaveLength(1)
    expect(allDayEventsForDay([event], new Date(2026, 5, 4).getTime())).toHaveLength(0)
  })
})

describe('allDayEventSpan', () => {
  // Computed fresh inside each test, not hoisted to the describe body: the describe
  // callback itself runs at COLLECTION time, before `beforeEach` has set `process.env.TZ`,
  // so a `const` computed here would freeze in whatever the ambient host TZ happens to be
  // rather than the DST zone this suite is testing under.
  const days = (): number[] => weekDays(new Date(2026, 5, 17).getTime()) // Mon 15 - Sun 21 June 2026

  it('spans exactly the days it covers within the week', () => {
    const event = allDayEvent({ startDate: '2026-06-16', endDate: '2026-06-19' })
    expect(allDayEventSpan(event, days())).toEqual({ startIndex: 1, endIndex: 3 })
  })

  it('clips a span that starts before the week to column 0', () => {
    const event = allDayEvent({ startDate: '2026-06-01', endDate: '2026-06-17' })
    expect(allDayEventSpan(event, days())).toEqual({ startIndex: 0, endIndex: 1 })
  })

  it('clips a span that ends after the week to the last column', () => {
    const event = allDayEvent({ startDate: '2026-06-20', endDate: '2026-07-01' })
    expect(allDayEventSpan(event, days())).toEqual({ startIndex: 5, endIndex: 6 })
  })

  it('is null for an event entirely outside the week', () => {
    const event = allDayEvent({ startDate: '2026-05-01', endDate: '2026-05-05' })
    expect(allDayEventSpan(event, days())).toBeNull()
  })
})

describe('limitChips', () => {
  it('passes items through untouched when they fit', () => {
    expect(limitChips([1, 2], 3)).toEqual({ shown: [1, 2], overflowCount: 0 })
  })

  it('truncates and counts the overflow', () => {
    expect(limitChips([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2, 3], overflowCount: 2 })
  })
})

describe('calendarCacheBounds / calendarWindowNote', () => {
  const window = { past: 42, future: 120 }

  it('is null for a range entirely inside the cache window', () => {
    const today = new Date(2026, 5, 15, 12).getTime()
    const range = localDayBounds(today)
    expect(calendarWindowNote(range, today, window)).toBeNull()
  })

  it('names the window span when the range starts before it', () => {
    const today = new Date(2026, 5, 15, 12).getTime()
    const farPast = localDayBounds(new Date(2025, 0, 1).getTime())
    const note = calendarWindowNote(farPast, today, window)
    expect(note).not.toBeNull()
    expect(note).toContain('Calendar events are shown from')
    const cache = calendarCacheBounds(today, window)
    expect(note).toContain(
      new Date(cache.start).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      })
    )
  })

  it('names the window span when the range ends after it', () => {
    const today = new Date(2026, 5, 15, 12).getTime()
    const farFuture = localDayBounds(new Date(2028, 0, 1).getTime())
    expect(calendarWindowNote(farFuture, today, window)).not.toBeNull()
  })

  it('includes a weekday name alongside the date', () => {
    const today = new Date(2026, 5, 15, 12).getTime()
    const farPast = localDayBounds(new Date(2025, 0, 1).getTime())
    const note = calendarWindowNote(farPast, today, window)
    // A weekday token reads as letters immediately followed by a comma (en-US locale style,
    // e.g. "Thu, 1 Jan 2025") — a plain "contains letters" check would also match the month
    // name, so this pins it to the weekday specifically.
    expect(note).toMatch(/[A-Za-z]{2,},/)
  })
})

describe('isViewActive', () => {
  it('is true only for the option matching the current view, for every current view', () => {
    for (const current of VIEW_MODES) {
      const active = VIEW_MODES.filter((option) => isViewActive(option, current))
      expect(active).toEqual([current])
    }
  })

  it('is false for every option when compared against a view none of them equal', () => {
    // Guards the exact shape of bug reported live: a stale/mismatched `current` must not
    // leave some OTHER option highlighted — it must leave none highlighted at all.
    for (const option of VIEW_MODES) {
      expect(isViewActive(option, 'unknown' as never)).toBe(false)
    }
  })
})

describe('formatEventStart', () => {
  // This computer's clock for these tests is Asia/Dubai (UTC+4, no DST) — set locally
  // rather than via the file's usual America/New_York, since what's under test here is
  // exactly the LOCAL-vs-event-zone comparison, not DST.
  let dubaiOriginalTz: string | undefined

  beforeEach(() => {
    dubaiOriginalTz = process.env.TZ
    process.env.TZ = 'Asia/Dubai'
  })

  afterEach(() => {
    if (dubaiOriginalTz === undefined) delete process.env.TZ
    else process.env.TZ = dubaiOriginalTz
  })

  // 03:45 UTC — 07:45 in Dubai (+4), 07:15 in Tehran (+3:30), 07:45 in Muscat (+4, same as
  // Dubai). Built from Date.UTC so the instant itself never depends on the active TZ.
  const instant = Date.UTC(2026, 5, 15, 3, 45)

  it('shows both zones when the event zone reads a different wall-clock time', () => {
    expect(formatEventStart(instant, 'Asia/Tehran')).toBe('07:15 Tehran · 07:45 local')
  })

  it('shows only local time when the event zone reads the same wall-clock time as local', () => {
    expect(formatEventStart(instant, 'Asia/Muscat')).toBe('07:45')
  })

  it('shows only local time when there is no recorded zone', () => {
    expect(formatEventStart(instant, null)).toBe('07:45')
  })
})

describe('formatWeekHeading', () => {
  // Weekday tokens (en-US locale, matching the rest of this file's assumptions) are runs of
  // 2+ letters — distinct from the bare numeric day, so this also fails if a weekday were
  // silently dropped from one end but not the other.
  const WEEKDAY_TOKEN = /[A-Za-z]{2,}/

  it('includes a weekday name at both ends for a week within one month', () => {
    const { start, end } = localWeekBounds(new Date(2026, 5, 17, 9).getTime()) // Mon 15 - Sun 21 June 2026
    const heading = formatWeekHeading(start, end)
    const [startLabel, endLabel] = heading.split('–').map((s) => s.trim())
    expect(startLabel).toMatch(WEEKDAY_TOKEN)
    expect(endLabel).toMatch(WEEKDAY_TOKEN)
  })

  it('includes a weekday name at both ends for a week crossing months', () => {
    const start = new Date(2026, 5, 29).getTime() // Mon 29 June 2026
    const end = new Date(2026, 6, 6).getTime() // next Mon 6 July 2026
    const heading = formatWeekHeading(start, end)
    const [startLabel, endLabel] = heading.split('–').map((s) => s.trim())
    expect(startLabel).toMatch(WEEKDAY_TOKEN)
    expect(endLabel).toMatch(WEEKDAY_TOKEN)
  })

  it('shows the year on both ends for a week crossing a year boundary', () => {
    const start = new Date(2025, 11, 29).getTime() // Mon 29 Dec 2025
    const end = new Date(2026, 0, 5).getTime() // next Mon 5 Jan 2026
    const heading = formatWeekHeading(start, end)
    expect(heading).toContain('2025')
    expect(heading).toContain('2026')
  })
})

