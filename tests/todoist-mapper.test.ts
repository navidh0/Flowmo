/**
 * Pure mapping rules: priority inversion and the calendar-day-from-due computation.
 *
 * TZ is fixed to a non-UTC, DST-observing zone before any Date is touched, for the same
 * reason `tests/stats-repo.test.ts` does it — a zoned due datetime's calendar day must be
 * computed from the *local* clock, and a bug that used UTC would only show up off UTC.
 */
process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'
import {
  buildDueForDateChange,
  calendarDayFromDue,
  dueDateFromRemote,
  toLocalPriority,
  toRemotePriority
} from '../src/main/integrations/todoist/mapper'

if (new Date(2026, 5, 15).getTimezoneOffset() === 0) {
  throw new Error('TZ override did not take effect — tests would be meaningless on UTC')
}

describe('priority inversion', () => {
  it('maps Flowdo 1 (highest) to Todoist 4 (urgent) and back', () => {
    expect(toRemotePriority(1)).toBe(4)
    expect(toRemotePriority(2)).toBe(3)
    expect(toRemotePriority(3)).toBe(2)
    expect(toRemotePriority(4)).toBe(1)

    expect(toLocalPriority(4)).toBe(1)
    expect(toLocalPriority(1)).toBe(4)
  })

  it('degrades an out-of-range remote priority to 3 rather than throwing', () => {
    expect(toLocalPriority(0)).toBe(3)
    expect(toLocalPriority(9)).toBe(3)
  })
})

describe('calendarDayFromDue', () => {
  it('keeps a date-only due verbatim', () => {
    expect(calendarDayFromDue('2026-03-01')).toBe('2026-03-01')
  })

  it('takes the date part of a floating datetime without any zone conversion', () => {
    // No trailing offset/'Z' => floating; the date part is the day everywhere.
    expect(calendarDayFromDue('2026-03-01T23:30:00')).toBe('2026-03-01')
  })

  it('computes the local calendar day of a zoned datetime, which can differ from its UTC date', () => {
    // 2026-03-02T06:30:00Z is 2026-03-01T22:30 in America/Los_Angeles (UTC-8 in March
    // before DST) — the day rolls back a day in the host's local zone.
    expect(calendarDayFromDue('2026-03-02T06:30:00Z')).toBe('2026-03-01')
  })

  it('dueDateFromRemote is null for no due, and unwraps a due object otherwise', () => {
    expect(dueDateFromRemote(null)).toBeNull()
    expect(dueDateFromRemote({ date: '2026-04-05' })).toBe('2026-04-05')
  })

  it('degrades a due string Date cannot parse to null rather than "NaN-NaN-NaN"', () => {
    expect(calendarDayFromDue('2026-13-99T99:99:99+99:99')).toBeNull()
    expect(dueDateFromRemote({ date: '2026-13-99T99:99:99+99:99' })).toBeNull()
  })
})

describe('buildDueForDateChange', () => {
  it('sends a bare { date } when there was no prior due at all', () => {
    expect(buildDueForDateChange('2026-05-01', null)).toEqual({ date: '2026-05-01' })
  })

  it('sends a bare { date } for a date-only, non-recurring due', () => {
    const previous = { date: '2026-01-01', timezone: null, string: '2026-01-01', lang: 'en', is_recurring: false }
    expect(buildDueForDateChange('2026-02-02', previous)).toEqual({ date: '2026-02-02' })
  })

  it('sends null to clear the due date, even when the prior due was recurring or timed', () => {
    expect(buildDueForDateChange(null, { date: '2026-01-01', is_recurring: true, string: 'every day' })).toBeNull()
  })

  it('keeps the recurrence rule (string/is_recurring/lang) when only the day changes', () => {
    const previous = { date: '2026-01-01', string: 'every monday', lang: 'en', is_recurring: true, timezone: null }
    const result = buildDueForDateChange('2026-01-08', previous)
    expect(result).toEqual({ date: '2026-01-08', string: 'every monday', is_recurring: true, lang: 'en' })
  })

  it('keeps the local time of day on the new day for a floating (non-recurring) timed due', () => {
    const previous = { date: '2026-01-01T09:30:00', timezone: null, string: 'tomorrow at 9:30am', is_recurring: false }
    const result = buildDueForDateChange('2026-10-02', previous)
    expect(result).toEqual({ date: '2026-10-02T09:30:00' })
  })

  it('keeps the local time of day for a fixed-timezone (non-recurring) datetime due', () => {
    // 2026-01-01T17:00:00Z is 09:00 in America/Los_Angeles (UTC-8 in January).
    const previous = {
      date: '2026-01-01T17:00:00Z',
      timezone: 'America/Los_Angeles',
      string: 'tomorrow at 9am',
      is_recurring: false
    }
    const result = buildDueForDateChange('2026-07-04', previous)
    expect(result?.timezone).toBe('America/Los_Angeles')
    // July is DST (UTC-7): 09:00 local on 2026-07-04 is 16:00Z, not 17:00Z.
    expect(result?.date).toBe('2026-07-04T16:00:00.000Z')
  })

  it('keeps both the recurrence rule and the time of day for a recurring, timed due', () => {
    const previous = {
      date: '2026-01-01T12:00:00',
      timezone: null,
      string: 'every day at 12',
      lang: 'en',
      is_recurring: true
    }
    const result = buildDueForDateChange('2026-03-15', previous)
    expect(result).toEqual({
      date: '2026-03-15T12:00:00',
      string: 'every day at 12',
      is_recurring: true,
      lang: 'en'
    })
  })
})
