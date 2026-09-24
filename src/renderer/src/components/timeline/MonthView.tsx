/**
 * The Month view: a Monday-first grid of weeks covering the month, with leading/trailing
 * days from adjacent months dimmed. Each cell shows the day number, that day's total focus
 * time, and event chips (all-day first, then timed by start time), truncated to what fits
 * with a "+N more" overflow. Clicking a day switches to Day view on that date.
 */

import { useMemo } from 'react'
import type { CalendarEvent, Project, Session } from '@shared/types'
import { formatDuration, toLocalDateKey } from '@renderer/lib/format'
import { formatClockTime, formatEventStart } from './format'
import { isInMonth, localDayBounds, monthGrid, WEEK_STARTS_ON } from './layout'
import {
  allDayEventsForDay,
  bucketSessionsByDay,
  focusMsForDay,
  limitChips,
  timedEventsForDay
} from './views'

const MAX_CHIPS = 3

/** Mon..Sun column headers, following the same `WEEK_STARTS_ON` constant the grid itself
 *  uses, so the labels can never drift out of sync with the columns underneath them. */
const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, i) =>
  new Date(2026, 0, 5 + ((i + WEEK_STARTS_ON - 1) % 7)).toLocaleDateString(undefined, {
    weekday: 'short'
  })
)

export interface MonthCellChip {
  key: string
  title: string
  color: string
  time: string | null
  /** Full text for the native `title` attribute — includes the dual-zone start label when
   *  the event's own time zone reads differently from local (`formatEventStart`), since the
   *  visible chip only ever shows the local time to save space. */
  tooltip: string
}

export interface MonthViewProps {
  anchorMs: number
  sessions: Session[]
  calendarEvents: CalendarEvent[]
  feedColors: Map<number, string>
  projects: Project[]
  onSelectDay: (dayMs: number) => void
}

export function MonthView({
  anchorMs,
  sessions,
  calendarEvents,
  feedColors,
  onSelectDay
}: MonthViewProps): React.JSX.Element {
  const grid = useMemo(() => monthGrid(anchorMs), [anchorMs])
  const sessionsByDay = useMemo(() => bucketSessionsByDay(sessions), [sessions])
  const today = useMemo(() => toLocalDateKey(Date.now()), [])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="grid grid-cols-7 border-b border-[var(--color-border)]">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="px-1.5 py-1.5 text-center text-[11px] font-medium text-[var(--color-text-muted)]">
            {label}
          </div>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-7 [grid-auto-rows:minmax(84px,1fr)]">
        {grid.weeks.flat().map((dayMs) => {
          const key = toLocalDateKey(dayMs)
          const inMonth = isInMonth(dayMs, grid.monthMs)
          const isToday = key === today
          const daySessions = sessionsByDay.get(key) ?? []
          const focusMs = focusMsForDay(daySessions)

          const allDayChips: MonthCellChip[] = allDayEventsForDay(calendarEvents, dayMs).map((e) => ({
            key: `all-${e.id}`,
            title: e.title,
            color: feedColors.get(e.feedId) ?? 'var(--color-focus)',
            time: null,
            tooltip: e.title
          }))
          const timedChips: MonthCellChip[] = timedEventsForDay(calendarEvents, localDayBounds(dayMs))
            .sort((a, b) => a.event.startMs - b.event.startMs)
            .map((occ) => {
              // The chip itself only ever shows the LOCAL time (space is tight); the fuller
              // "07:15 Tehran · 07:45 local" label, when the event's own zone differs, goes
              // in the tooltip instead — see `formatEventStart`.
              const startLabel = formatEventStart(occ.event.startMs, occ.event.timeZone)
              return {
                key: `timed-${occ.event.id}`,
                title: occ.event.title,
                color: feedColors.get(occ.event.feedId) ?? 'var(--color-focus)',
                time: occ.continuesFromPrevious ? null : formatClockTime(occ.event.startMs),
                tooltip: occ.continuesFromPrevious ? occ.event.title : `${startLabel} ${occ.event.title}`
              }
            })

          const { shown, overflowCount } = limitChips([...allDayChips, ...timedChips], MAX_CHIPS)

          return (
            <button
              key={dayMs}
              type="button"
              onClick={() => onSelectDay(dayMs)}
              aria-label={`Open ${new Date(dayMs).toLocaleDateString()} in Day view`}
              className={`flex min-w-0 flex-col items-stretch gap-1 border-b border-r border-[var(--color-border)]/60 p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ${
                inMonth ? '' : 'opacity-40'
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[11px] ${
                    isToday
                      ? 'flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-focus)] font-semibold text-[#0a0d12]'
                      : 'text-[var(--color-text)]'
                  }`}
                >
                  {new Date(dayMs).getDate()}
                </span>
                {focusMs > 0 ? (
                  <span className="truncate text-[10px] text-[var(--color-text-muted)]">
                    {formatDuration(focusMs)}
                  </span>
                ) : null}
              </div>

              <div className="flex min-w-0 flex-col gap-0.5">
                {shown.map((chip) => (
                  <span
                    key={chip.key}
                    title={chip.tooltip}
                    className="truncate rounded px-1 py-0.5 text-[10px] font-medium text-[#0a0d12]"
                    style={{ backgroundColor: chip.color }}
                  >
                    {chip.time ? `${chip.time} ` : ''}
                    {chip.title}
                  </span>
                ))}
                {overflowCount > 0 ? (
                  <span className="truncate px-1 text-[10px] text-[var(--color-text-muted)]">
                    +{overflowCount} more
                  </span>
                ) : null}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
