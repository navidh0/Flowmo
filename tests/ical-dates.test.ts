/**
 * `src/main/integrations/ical/dates.ts` — local calendar-day arithmetic, and specifically
 * that `refreshWindow()` defaults from the shared `CALENDAR_CACHE_DAYS` constant rather than
 * keeping a second copy of the numbers (the calendar's Week/Month views need a wider window
 * than the original day-only cache did).
 */
process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'

if (new Date(2026, 5, 15).getTimezoneOffset() === 0) {
  throw new Error('TZ override did not take effect — tests would be meaningless on UTC')
}

import { CALENDAR_CACHE_DAYS } from '@shared/types'
import { dayKey, refreshWindow, touchedDayKeyRange } from '../src/main/integrations/ical/dates'

describe('refreshWindow', () => {
  it('defaults pastDays/futureDays from CALENDAR_CACHE_DAYS', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
    const { fromMs, toMs } = refreshWindow(now)
    const withExplicitDefaults = refreshWindow(now, CALENDAR_CACHE_DAYS.past, CALENDAR_CACHE_DAYS.future)
    expect(fromMs).toBe(withExplicitDefaults.fromMs)
    expect(toMs).toBe(withExplicitDefaults.toMs)
  })

  it('is the half-open range [today - past, today + future] in local days', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
    const { fromMs, toMs } = refreshWindow(now)

    expect(dayKey(new Date(fromMs))).toBe(
      dayKey(new Date(2026, 5, 15 - CALENDAR_CACHE_DAYS.past))
    )
    // toMs is exclusive: it is local midnight the day AFTER the last included day.
    const lastIncludedDay = new Date(2026, 5, 15 + CALENDAR_CACHE_DAYS.future)
    expect(dayKey(new Date(toMs - 1))).toBe(dayKey(lastIncludedDay))
    expect(dayKey(new Date(toMs))).not.toBe(dayKey(lastIncludedDay))
  })

  it('still accepts explicit pastDays/futureDays overrides', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
    const { fromMs, toMs } = refreshWindow(now, 1, 1)
    expect(dayKey(new Date(fromMs))).toBe(dayKey(new Date(2026, 5, 14)))
    expect(dayKey(new Date(toMs - 1))).toBe(dayKey(new Date(2026, 5, 16)))
  })
})

describe('touchedDayKeyRange', () => {
  it('excludes a `to` that lands exactly on a local midnight', () => {
    const from = new Date(2026, 5, 3).getTime()
    const to = new Date(2026, 5, 4).getTime() // local midnight of the 4th: exclusive
    const { firstDayKey, dayAfterLastTouchedKey } = touchedDayKeyRange(from, to)
    expect(firstDayKey).toBe('2026-06-03')
    expect(dayAfterLastTouchedKey).toBe('2026-06-04')
  })
})
