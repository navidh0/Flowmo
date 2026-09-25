/**
 * Day/Week/Month range computation and bucketing — the pure logic behind the view switcher.
 * No React, no IPC, same reasoning as `layout.ts`: exercised directly by
 * `tests/timeline-views.test.ts` with `process.env.TZ` pointed at a DST zone.
 */

import { DEFAULT_SETTINGS } from '@shared/types'
import type { CalendarEvent, Session, Weekday } from '@shared/types'
// Relative, not `@renderer/lib/format` — the vitest config that runs this file's tests only
// aliases `@shared`, and this module needs to import cleanly under both electron-vite (app)
// and vitest (tests/timeline-views.test.ts).
import { toLocalDateKey } from '../../lib/format'
import {
  clipToDay,
  localDayBounds,
  localWeekBounds,
  monthGrid,
  shiftLocalDay,
  shiftLocalMonth,
  shiftLocalWeek,
  type ClippedRange,
  type DayBounds,
  type MonthGrid
} from './layout'

export type ViewMode = 'day' | 'week' | 'month'

/** The switcher's options, in display order — the one list `ViewSwitcher` renders from, so
 *  a mode can't be added to `ViewMode` without also appearing (or being deliberately left
 *  out) here. */
export const VIEW_MODES: readonly ViewMode[] = ['day', 'week', 'month']

/** Whether `option` is the currently-selected view — the entire "which segment is
 *  highlighted" decision, factored out so it's one pure equality check shared by every
 *  segment's `aria-checked`/style, rather than each segment re-deriving it. */
export function isViewActive(option: ViewMode, current: ViewMode): boolean {
  return option === current
}

/** The instants covered by what's currently on screen for `view`, anchored on `anchorMs`.
 *  Month's range is the full leading/trailing grid, matching what `monthGrid` renders and
 *  therefore what needs data fetched for it. `weekStartsOn` (`Settings.weekStartsOn`) picks
 *  which weekday Week and Month's rows start on; it defaults to Monday for callers that
 *  don't care (mostly tests). */
export function viewRangeBounds(
  view: ViewMode,
  anchorMs: number,
  weekStartsOn: Weekday = DEFAULT_SETTINGS.weekStartsOn
): DayBounds {
  if (view === 'day') return localDayBounds(anchorMs)
  if (view === 'week') return localWeekBounds(anchorMs, weekStartsOn)
  const grid = monthGrid(anchorMs, weekStartsOn)
  const firstWeek = grid.weeks[0]
  const lastWeek = grid.weeks[grid.weeks.length - 1]
  const firstDay = firstWeek?.[0] ?? anchorMs
  const lastDay = lastWeek?.[6] ?? anchorMs
  return { start: localDayBounds(firstDay).start, end: localDayBounds(lastDay).end }
}

/** Prev/Today/Next steps by the current view's own unit: a day, a week, or a month. */
export function shiftView(view: ViewMode, anchorMs: number, delta: number): number {
  if (view === 'day') return shiftLocalDay(anchorMs, delta)
  if (view === 'week') return shiftLocalWeek(anchorMs, delta)
  return shiftLocalMonth(anchorMs, delta)
}

export type { MonthGrid }

// ─────────────────────────────────────────────────────────────────────────────
// Bucketing sessions and events into local days
// ─────────────────────────────────────────────────────────────────────────────

/** Sessions keyed by the local day they STARTED — never by any part of their span past
 *  midnight, matching `sessions.listRange`'s own match on `started_at`. */
export function bucketSessionsByDay(sessions: Session[]): Map<string, Session[]> {
  const byDay = new Map<string, Session[]>()
  for (const s of sessions) {
    const key = toLocalDateKey(s.startedAt)
    const bucket = byDay.get(key)
    if (bucket) bucket.push(s)
    else byDay.set(key, [s])
  }
  return byDay
}

/** Total time from FOCUS sessions on a day, abandoned ones included — `focusMs` is time
 *  spent, not time completed (see CLAUDE.md: do not reconcile it with actualPomodoros). */
export function focusMsForDay(sessions: Session[]): number {
  return sessions.filter((s) => s.kind === 'focus').reduce((sum, s) => sum + s.actualMs, 0)
}

export interface DayEventOccurrence {
  event: Extract<CalendarEvent, { allDay: false }>
  clipped: ClippedRange
  /** True when the piece on this day does not start at the event's real start (it began
   *  the previous day and is continuing into this one). */
  continuesFromPrevious: boolean
}

/** Timed events touching a day, each clipped to that day's bounds. An event spanning
 *  midnight appears once per day it touches, never duplicated whole. */
export function timedEventsForDay(
  events: CalendarEvent[],
  bounds: DayBounds
): DayEventOccurrence[] {
  return events
    .filter((e): e is Extract<CalendarEvent, { allDay: false }> => !e.allDay)
    .filter((e) => e.startMs < bounds.end && e.endMs > bounds.start)
    .map((e) => ({
      event: e,
      clipped: clipToDay(Math.max(e.startMs, bounds.start), e.endMs, bounds),
      continuesFromPrevious: e.startMs < bounds.start
    }))
}

/** All-day events covering a day — `startDate`/`endDate` are local calendar days with
 *  `endDate` exclusive (RFC 5545), so a day just needs to fall in `[startDate, endDate)`. */
export function allDayEventsForDay(
  events: CalendarEvent[],
  dayMs: number
): Extract<CalendarEvent, { allDay: true }>[] {
  const key = toLocalDateKey(dayMs)
  return events.filter(
    (e): e is Extract<CalendarEvent, { allDay: true }> =>
      e.allDay && e.startDate <= key && key < e.endDate
  )
}

export interface DaySpan {
  /** Index into the `days` array this span was computed against. */
  startIndex: number
  endIndex: number
}

/**
 * Where a multi-day all-day event falls within a contiguous, ascending run of local-day
 * anchors (a week's 7 days, or a month grid's rows flattened) — `null` when it doesn't
 * overlap that run at all. Used to draw one bar across the week/month columns it covers,
 * clipped to the columns actually shown.
 */
export function allDayEventSpan(
  event: Extract<CalendarEvent, { allDay: true }>,
  days: number[]
): DaySpan | null {
  let startIndex = -1
  let endIndex = -1
  days.forEach((d, i) => {
    const key = toLocalDateKey(d)
    if (event.startDate <= key && key < event.endDate) {
      if (startIndex === -1) startIndex = i
      endIndex = i
    }
  })
  return startIndex === -1 ? null : { startIndex, endIndex }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chip overflow (month cells)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChipOverflow<T> {
  shown: T[]
  /** 0 when everything fit. */
  overflowCount: number
}

/** Truncates a day cell's chips to `max`, folding the rest into a "+N more" count. */
export function limitChips<T>(items: T[], max: number): ChipOverflow<T> {
  if (items.length <= max) return { shown: items, overflowCount: 0 }
  return { shown: items.slice(0, max), overflowCount: items.length - max }
}

// ─────────────────────────────────────────────────────────────────────────────
// The calendar cache window note
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheWindow {
  past: number
  future: number
}

/** The instants the calendar cache actually covers around `todayMs`: `today - past` days
 *  through the end of `today + future` days. */
export function calendarCacheBounds(todayMs: number, window: CacheWindow): DayBounds {
  const start = localDayBounds(shiftLocalDay(todayMs, -window.past)).start
  const end = localDayBounds(shiftLocalDay(todayMs, window.future)).end
  return { start, end }
}

/**
 * `null` when `range` sits entirely inside the calendar cache window; otherwise a message
 * naming the window's actual span, so a month scrolled far away reads as "out of range",
 * never as an empty calendar.
 */
export function calendarWindowNote(
  range: DayBounds,
  todayMs: number,
  window: CacheWindow
): string | null {
  const cache = calendarCacheBounds(todayMs, window)
  if (range.start >= cache.start && range.end <= cache.end) return null

  const fmt = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    })
  // `cache.end` is the exclusive start of the day after the window; the window's last
  // INCLUSIVE day reads one day earlier.
  const lastInclusive = shiftLocalDay(cache.end, -1)
  return `Calendar events are shown from ${fmt(cache.start)} to ${fmt(lastInclusive)}`
}
