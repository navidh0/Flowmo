/**
 * Pure selection/grouping/sorting logic behind the "Today" and "Upcoming" smart views.
 *
 * Deliberately dependency-free (no React, no `@renderer/*` imports): it needs to be testable
 * under the existing vitest config, which only aliases `@shared`, not the renderer's own
 * path aliases. `localDateKey`/`addLocalDays` below duplicate the shape of
 * `lib/format.ts`'s `toLocalDateKey` rather than importing it — callers that already have a
 * `Date`/`ms` and need the CANONICAL "today" key should still go through
 * `lib/format.ts#toLocalDateKey` (never `toISOString`, which is UTC); this module only ever
 * receives that key as a plain string argument, or produces one from it via day arithmetic.
 *
 * All day-key math uses calendar arithmetic (`Date` field setters, never raw millisecond
 * addition) so a DST transition cannot shift a bucket — the same invariant `db/repo/stats.ts`
 * documents for calendar-day boundaries.
 */

import type { TaskWithStats } from '@shared/types'

/** 'YYYY-MM-DD' for the local calendar day containing `ms`. Mirrors `lib/format.ts`. */
function localDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** `dateKey` shifted by `days` local calendar days (negative goes backward). */
export function addLocalDays(dateKey: string, days: number): string {
  const parts = dateKey.split('-').map(Number)
  const y = parts[0] ?? 1970
  const m = parts[1] ?? 1
  const d = parts[2] ?? 1
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + days)
  return localDateKey(date.getTime())
}

/**
 * Epoch ms of the next local midnight strictly after `nowMs`.
 *
 * Built from `Date` field setters (`new Date(y, m, d + 1)`), not `nowMs + 24h` — a day that
 * contains a DST transition is 23 or 25 real hours, and adding a flat 24h would land the
 * rollover at 11pm or 1am instead of midnight.
 */
export function nextLocalMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
}

/**
 * Ascending within a due-date group: timed tasks by `dueTime` first, then untimed; ties by
 * priority (1 = highest), then by the task's persisted sort order.
 */
function compareWithinGroup(a: TaskWithStats, b: TaskWithStats): number {
  if (a.dueTime !== null && b.dueTime !== null) {
    if (a.dueTime !== b.dueTime) return a.dueTime < b.dueTime ? -1 : 1
  } else if (a.dueTime !== null) {
    return -1
  } else if (b.dueTime !== null) {
    return 1
  }
  if (a.priority !== b.priority) return a.priority - b.priority
  return a.sortOrder - b.sortOrder
}

export interface TodaySelection {
  /** `dueDate < todayKey`. Rendered as its own, visibly-marked group above "Today". */
  overdue: TaskWithStats[]
  /** `dueDate === todayKey`. */
  today: TaskWithStats[]
}

/** Open tasks due today or earlier, split into "Overdue" and "Today" groups, each sorted. */
export function selectToday(tasks: TaskWithStats[], todayKey: string): TodaySelection {
  const overdue = tasks.filter((t) => t.dueDate !== null && t.dueDate < todayKey)
  const today = tasks.filter((t) => t.dueDate === todayKey)
  overdue.sort(compareWithinGroup)
  today.sort(compareWithinGroup)
  return { overdue, today }
}

/** Every open task due today or earlier — the Today sidebar badge. */
export function countToday(tasks: TaskWithStats[], todayKey: string): number {
  return tasks.reduce((n, t) => n + (t.dueDate !== null && t.dueDate <= todayKey ? 1 : 0), 0)
}

export interface UpcomingDay {
  dateKey: string
  tasks: TaskWithStats[]
}

/**
 * Open tasks due in the next `days` local calendar days (tomorrow .. today+days), one bucket
 * per date that actually has something due — an empty day gets no heading at all.
 */
export function selectUpcoming(
  tasks: TaskWithStats[],
  todayKey: string,
  days = 7
): UpcomingDay[] {
  const buckets: UpcomingDay[] = []
  for (let i = 1; i <= days; i++) {
    const dateKey = addLocalDays(todayKey, i)
    const dayTasks = tasks.filter((t) => t.dueDate === dateKey)
    if (dayTasks.length === 0) continue
    dayTasks.sort(compareWithinGroup)
    buckets.push({ dateKey, tasks: dayTasks })
  }
  return buckets
}

/** Every open task due in the next `days` local calendar days — the Upcoming sidebar badge. */
export function countUpcoming(tasks: TaskWithStats[], todayKey: string, days = 7): number {
  const start = addLocalDays(todayKey, 1)
  const end = addLocalDays(todayKey, days)
  return tasks.reduce(
    (n, t) => n + (t.dueDate !== null && t.dueDate >= start && t.dueDate <= end ? 1 : 0),
    0
  )
}
