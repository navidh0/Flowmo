/**
 * The Month view: a grid of weeks covering the month, starting on `weekStartsOn`
 * (`Settings.weekStartsOn`), with leading/trailing days from adjacent months dimmed. Each
 * cell shows the day number, that day's total focus time, and event chips (all-day first,
 * then timed by start time), truncated to what fits with a "+N more" overflow. Clicking a
 * day switches to Day view on that date.
 */

import { useMemo } from 'react'
import type { CalendarEvent, Project, Session, Weekday } from '@shared/types'
import { formatDuration, toLocalDateKey } from '@renderer/lib/format'
import { formatClockTime, formatDayHeading, formatEventStart } from './format'
import { eventColor } from './blocks'
import { isInMonth, localDayBounds, monthGrid } from './layout'
import {
  allDayEventsForDay,
  bucketSessionsByDay,
  focusMsForDay,
  limitChips,
  timedEventsForDay
} from './views'

const MAX_CHIPS = 3

/** 4 Jan 2026 is a Sunday — the reference date the weekday header row is built from, so it
 *  never depends on which month is actually showing. */
const REFERENCE_SUNDAY = new Date(2026, 0, 4)

/** Short weekday labels for the header row, starting on `weekStartsOn` — kept in step with
 *  the grid itself, which is built from the same setting, so the labels can never drift out
 *  of sync with the columns underneath them. */
function weekdayLabels(weekStartsOn: Weekday): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(REFERENCE_SUNDAY)
    d.setDate(d.getDate() + ((weekStartsOn + i) % 7))
    return d.toLocaleDateString(undefined, { weekday: 'short' })
  })
}

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
  weekStartsOn: Weekday
  onSelectDay: (dayMs: number) => void
}

export function MonthView({
  anchorMs,
  sessions,
  calendarEvents,
  feedColors,
  weekStartsOn,
  onSelectDay
}: MonthViewProps): React.JSX.Element {
  const grid = useMemo(() => monthGrid(anchorMs, weekStartsOn), [anchorMs, weekStartsOn])
  const sessionsByDay = useMemo(() => bucketSessionsByDay(sessions), [sessions])
  const today = useMemo(() => toLocalDateKey(Date.now()), [])
  const labels = useMemo(() => weekdayLabels(weekStartsOn), [weekStartsOn])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="grid grid-cols-7 border-b border-[var(--color-border)]">
        {labels.map((label, i) => (
          <div key={`${label}-${i}`} className="px-1.5 py-1.5 text-center text-[11px] font-medium text-[var(--color-text-muted)]">
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
            color: eventColor(e.feedId, feedColors),
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
                color: eventColor(occ.event.feedId, feedColors),
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
              aria-label={`Open ${formatDayHeading(dayMs)} in Day view`}
              title={formatDayHeading(dayMs)}
              className={`flex min-w-0 flex-col items-stretch gap-1 border-b border-r border-[var(--color-border)]/60 p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ${
                inMonth ? '' : 'opacity-40'
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[11px] ${
                    isToday
                      ? 'flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-focus)] font-semibold text-[var(--color-on-accent)]'
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
                    // `--color-on-swatch`, not `--color-on-accent`: `chip.color` is a
                    // calendar feed's own colour (a swatch someone picked, or `eventColor`'s
                    // theme-independent fallback), not a design accent — see the token's own
                    // comment in index.css and timeline/Block.tsx's.
                    className="truncate rounded px-1 py-0.5 text-[10px] font-medium text-[var(--color-on-swatch)]"
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
