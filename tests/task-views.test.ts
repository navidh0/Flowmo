/**
 * `components/tasks/views.ts` — the pure selection/grouping/sorting behind the Today and
 * Upcoming smart views, plus the midnight-rollover date-key math.
 *
 * TZ is set to a non-UTC, DST-observing zone BEFORE any `Date` is constructed anywhere in
 * this file (including by imports), same pattern as tests/stats-repo.test.ts, so a bug where
 * day-key arithmetic silently assumed UTC — or added a flat 24h instead of stepping calendar
 * fields — would fail regardless of the machine running the suite.
 */
process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'
import type { TaskWithStats } from '@shared/types'
import {
  addLocalDays,
  countToday,
  countUpcoming,
  nextLocalMidnight,
  selectToday,
  selectUpcoming
} from '../src/renderer/src/components/tasks/views'

// Verify the TZ override actually took effect before trusting any test below. If Node
// picked this up as UTC, `getTimezoneOffset()` on a summer date would be 0.
if (new Date(2026, 5, 15).getTimezoneOffset() === 0) {
  throw new Error('TZ override did not take effect — tests would be meaningless on UTC')
}

let nextId = 1

function task(overrides: Partial<TaskWithStats> = {}): TaskWithStats {
  const id = nextId++
  return {
    id,
    projectId: 1,
    title: `Task ${id}`,
    notes: null,
    priority: 3,
    dueDate: null,
    dueTime: null,
    estimatedPomodoros: null,
    sortOrder: id,
    completedAt: null,
    createdAt: 0,
    recurring: false,
    remoteDeletedAt: null,
    source: null,
    externalId: null,
    actualPomodoros: 0,
    focusMs: 0,
    subtaskTotal: 0,
    subtaskDone: 0,
    ...overrides
  }
}

/** Parses a 'YYYY-MM-DD' key into numeric parts — `noUncheckedIndexedAccess` makes
 *  `.split('-').map(Number)` destructure as possibly-`undefined`, so this centralises the
 *  (test-only) assertion that the key is well-formed. */
function parseDateKey(key: string): { y: number; m: number; d: number } {
  const [y, m, d] = key.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`Malformed date key: ${key}`)
  }
  return { y, m, d }
}

/** Finds the local spring-forward transition day in `year`, rather than hard-coding one —
 *  the exact date moves with the calendar and hard-coding it would silently stop testing a
 *  real transition. */
function springForwardDateKey(year: number): string {
  for (let month = 0; month < 12; month++) {
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    for (let day = 1; day <= daysInMonth; day++) {
      const before = new Date(year, month, day, 0, 0, 0, 0).getTimezoneOffset()
      const after = new Date(year, month, day + 1, 0, 0, 0, 0).getTimezoneOffset()
      // Spring forward: the UTC offset magnitude shrinks (PST -8h -> PDT -7h is +480 -> +420).
      if (after < before) {
        const m = String(month + 1).padStart(2, '0')
        const d = String(day).padStart(2, '0')
        return `${year}-${m}-${d}`
      }
    }
  }
  throw new Error(`No DST transition found in ${year} — TZ is probably not DST-observing`)
}

describe('addLocalDays', () => {
  it('steps forward by calendar days, not fixed 24h blocks', () => {
    expect(addLocalDays('2026-02-27', 1)).toBe('2026-02-28')
    expect(addLocalDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('crosses the spring-forward day without drifting a day', () => {
    const dstDay = springForwardDateKey(2027)
    // The day before, the day of, and the day after should all be exactly one calendar day
    // apart, even though the DST day itself is only 23 real hours long.
    const before = addLocalDays(dstDay, -1)
    const after = addLocalDays(dstDay, 1)
    expect(addLocalDays(before, 1)).toBe(dstDay)
    expect(addLocalDays(dstDay, 1)).toBe(after)
  })
})

describe('nextLocalMidnight', () => {
  it('returns the upcoming local midnight, not now + 24h', () => {
    const now = new Date(2026, 5, 15, 14, 30, 0).getTime() // 2:30pm, ordinary day
    const midnight = nextLocalMidnight(now)
    const expected = new Date(2026, 5, 16, 0, 0, 0, 0).getTime()
    expect(midnight).toBe(expected)
  })

  it('at exactly midnight, rolls to the NEXT day (never returns "now")', () => {
    const midnight = new Date(2026, 5, 15, 0, 0, 0, 0).getTime()
    expect(nextLocalMidnight(midnight)).toBe(new Date(2026, 5, 16, 0, 0, 0, 0).getTime())
  })

  it('on the spring-forward day, the gap to midnight is only 23 real hours', () => {
    const dstDay = springForwardDateKey(2027)
    const { y, m, d } = parseDateKey(dstDay)
    const morning = new Date(y, m - 1, d, 10, 0, 0, 0).getTime() // 10am, before the 2am jump
    const midnight = nextLocalMidnight(morning)
    const expectedMidnight = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime()
    expect(midnight).toBe(expectedMidnight)
    // A naive "midnight = startOfDay + 24h" would be off by an hour on this specific day —
    // assert the real gap is the shorter, correct one.
    const startOfDay = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
    expect(midnight - startOfDay).toBe(23 * 60 * 60 * 1000)
  })
})

describe('selectToday', () => {
  const TODAY = '2026-06-15'

  it('splits into overdue (< today) and today (=== today), excludes no-due and future tasks', () => {
    const overdueTask = task({ dueDate: '2026-06-10', title: 'stale' })
    const todayTask = task({ dueDate: TODAY, title: 'due today' })
    const futureTask = task({ dueDate: '2026-06-16', title: 'tomorrow' })
    const noDueTask = task({ dueDate: null, title: 'someday' })

    const { overdue, today } = selectToday(
      [overdueTask, todayTask, futureTask, noDueTask],
      TODAY
    )

    expect(overdue.map((t) => t.title)).toEqual(['stale'])
    expect(today.map((t) => t.title)).toEqual(['due today'])
  })

  it('orders timed tasks by dueTime ascending before untimed, then by priority, then sort order', () => {
    const untimedLowPriority = task({ dueDate: TODAY, dueTime: null, priority: 4, sortOrder: 1 })
    const timedLate = task({ dueDate: TODAY, dueTime: '19:00', priority: 3, sortOrder: 2 })
    const timedEarly = task({ dueDate: TODAY, dueTime: '09:00', priority: 3, sortOrder: 3 })
    const untimedHighPriority = task({ dueDate: TODAY, dueTime: null, priority: 1, sortOrder: 4 })

    const { today } = selectToday(
      [untimedLowPriority, timedLate, timedEarly, untimedHighPriority],
      TODAY
    )

    expect(today.map((t) => t.id)).toEqual([
      timedEarly.id,
      timedLate.id,
      untimedHighPriority.id,
      untimedLowPriority.id
    ])
  })
})

describe('countToday', () => {
  it('counts overdue and today tasks together, excluding future and no-due tasks', () => {
    const tasks = [
      task({ dueDate: '2026-06-10' }),
      task({ dueDate: '2026-06-15' }),
      task({ dueDate: '2026-06-16' }),
      task({ dueDate: null })
    ]
    expect(countToday(tasks, '2026-06-15')).toBe(2)
  })
})

describe('selectUpcoming', () => {
  const TODAY = '2026-06-15'

  it('buckets tasks due tomorrow..today+7 by date, skipping empty days and today/past', () => {
    const tomorrow = task({ dueDate: '2026-06-16', title: 'tomorrow' })
    const dayAfter = task({ dueDate: '2026-06-17', title: 'day after' })
    const farOut = task({ dueDate: '2026-06-22', title: 'in a week' })
    const tooFar = task({ dueDate: '2026-06-23', title: 'past the window' })
    const todayTask = task({ dueDate: TODAY, title: 'today, excluded here' })

    const days = selectUpcoming([tomorrow, dayAfter, farOut, tooFar, todayTask], TODAY)

    expect(days.map((d) => d.dateKey)).toEqual(['2026-06-16', '2026-06-17', '2026-06-22'])
    expect(days[0]?.tasks.map((t) => t.title)).toEqual(['tomorrow'])
  })

  it('sorts within a day the same way as Today', () => {
    const late = task({ dueDate: '2026-06-16', dueTime: '18:00', sortOrder: 1 })
    const early = task({ dueDate: '2026-06-16', dueTime: '08:00', sortOrder: 2 })
    const days = selectUpcoming([late, early], TODAY)
    expect(days[0]?.tasks.map((t) => t.id)).toEqual([early.id, late.id])
  })
})

describe('countUpcoming', () => {
  it('counts only the tomorrow..+7 window', () => {
    const tasks = [
      task({ dueDate: '2026-06-15' }), // today, excluded
      task({ dueDate: '2026-06-16' }),
      task({ dueDate: '2026-06-22' }),
      task({ dueDate: '2026-06-23' }) // day 8, excluded
    ]
    expect(countUpcoming(tasks, '2026-06-15')).toBe(2)
  })
})
