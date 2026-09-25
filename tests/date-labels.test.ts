/**
 * `formatDueGroupLabel` (src/renderer/src/lib/format.ts).
 *
 * TZ is set to a non-UTC, DST-observing zone BEFORE any `Date` is constructed anywhere in
 * this file (including by imports), same pattern as tests/task-views.test.ts, so a bug where
 * the weekday/date suffix silently assumed UTC — or the DST transition day landed on the
 * wrong side — would fail regardless of the machine running the suite.
 */
process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'
import { formatDueDate, formatDueGroupLabel } from '../src/renderer/src/lib/format'

// Verify the TZ override actually took effect before trusting any test below. If Node
// picked this up as UTC, `getTimezoneOffset()` on a summer date would be 0.
if (new Date(2026, 5, 15).getTimezoneOffset() === 0) {
  throw new Error('TZ override did not take effect — tests would be meaningless on UTC')
}

// Friday 25 Sep 2026, 09:00 local.
const NOW = new Date(2026, 8, 25, 9, 0, 0).getTime()

/** The expected weekday+date suffix, formatted the same way `formatDueGroupLabel` does —
 *  compared against this rather than a hard-coded literal, since the exact punctuation
 *  `toLocaleDateString` produces (`Fri 25 Sep` vs `Fri, Sep 25`) is locale/ICU-dependent, and
 *  this test only needs to pin down the calendar arithmetic and the weekday it names. */
function dateSuffix(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

describe('formatDueGroupLabel', () => {
  it('today gets the weekday and date appended', () => {
    expect(formatDueGroupLabel('2026-09-25', NOW)).toBe(`Today · ${dateSuffix(2026, 9, 25)}`)
    // And the suffix names the right day, not just whatever the same formatter produced:
    // 25 Sep 2026 is a Friday.
    const friday = new Date(2026, 8, 25).toLocaleDateString(undefined, { weekday: 'short' })
    expect(formatDueGroupLabel('2026-09-25', NOW)).toContain(friday)
    expect(new Date(2026, 8, 25).getDay()).toBe(5)
  })

  it('tomorrow gets the weekday and date appended', () => {
    expect(formatDueGroupLabel('2026-09-26', NOW)).toBe(`Tomorrow · ${dateSuffix(2026, 9, 26)}`)
  })

  it('yesterday gets the weekday and date appended', () => {
    expect(formatDueGroupLabel('2026-09-24', NOW)).toBe(`Yesterday · ${dateSuffix(2026, 9, 24)}`)
  })

  it('a date further out matches formatDueDate exactly, unchanged', () => {
    const dateKey = '2026-10-03'
    expect(formatDueGroupLabel(dateKey, NOW)).toBe(formatDueDate(dateKey, NOW))
  })

  it('an overdue date further back also matches formatDueDate exactly', () => {
    const dateKey = '2026-09-10'
    expect(formatDueGroupLabel(dateKey, NOW)).toBe(formatDueDate(dateKey, NOW))
  })

  it('returns null for null input', () => {
    expect(formatDueGroupLabel(null, NOW)).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(formatDueGroupLabel('not-a-date', NOW)).toBeNull()
    expect(formatDueGroupLabel('', NOW)).toBeNull()
  })

  it('a DST-transition day: "tomorrow" still means tomorrow across the spring-forward gap', () => {
    // 7 March 2026, 12:00 local (PST, UTC-8) — the US spring-forward is 8 March 2026, so the
    // next calendar day is the transition day itself. Calendar-day arithmetic (not a flat
    // +24h) must still call 2026-03-08 "tomorrow", not "today" or two days out.
    const dstNow = new Date(2026, 2, 7, 12, 0, 0).getTime()
    const label = formatDueGroupLabel('2026-03-08', dstNow)
    expect(label).not.toBeNull()
    expect(label?.startsWith('Tomorrow')).toBe(true)
  })
})
