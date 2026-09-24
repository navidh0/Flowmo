/**
 * The Week view: 7 Monday-first columns sharing one hour grid. Each column is its own local
 * day — its own `localDayBounds`/`hourMarks`, so a column can be 23, 24 or 25 hours long
 * exactly like the Day view, never assumed to be a uniform 24.
 *
 * Columns have a readable minimum width; a panel narrower than 7 columns' worth scrolls
 * horizontally rather than squashing them (`MIN_COLUMN_PX` + `overflow-x-auto`, no `w-[…]`
 * on the columns themselves — only the minimum is fixed, the columns still flex).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalendarEvent, Project, Session, TimerState } from '@shared/types'
import { toLocalDateKey } from '@renderer/lib/format'
import { eventBlocks, runningBlock, sessionBlocks } from './blocks'
import { formatColumnHeading, formatHourMark } from './format'
import { allDayEventSpan, bucketSessionsByDay } from './views'
import {
  dayFraction,
  hourMarks,
  isSameLocalDay,
  layoutOverlaps,
  localDayBounds,
  weekDays,
  type DayBounds
} from './layout'
import { Block } from './Block'

const ROW_HEIGHT_PX = 48
const MIN_COLUMN_PX = 104
const GUTTER_PX = 44

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [enabled])
  return now
}

export interface WeekViewProps {
  anchorMs: number
  sessions: Session[]
  calendarEvents: CalendarEvent[]
  feedColors: Map<number, string>
  projects: Project[]
  timerState: TimerState
  onSelectDay: (dayMs: number) => void
}

export function WeekView({
  anchorMs,
  sessions,
  calendarEvents,
  feedColors,
  projects,
  timerState,
  onSelectDay
}: WeekViewProps): React.JSX.Element {
  const days = useMemo(() => weekDays(anchorMs), [anchorMs])
  const columnBounds = useMemo<DayBounds[]>(() => days.map((d) => localDayBounds(d)), [days])
  const maxRows = useMemo(
    () => Math.max(...columnBounds.map((b) => hourMarks(b).length)),
    [columnBounds]
  )

  const sessionsByDay = useMemo(() => bucketSessionsByDay(sessions), [sessions])
  const allDayEvents = useMemo(
    () => calendarEvents.filter((e): e is Extract<CalendarEvent, { allDay: true }> => e.allDay),
    [calendarEvents]
  )

  const now = useNow(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const todayIndex = days.findIndex((d) => isSameLocalDay(now, d))

  useEffect(() => {
    if (todayIndex === -1 || !scrollRef.current) return
    const bounds = columnBounds[todayIndex]
    if (!bounds) return
    const top = dayFraction(now, bounds) * maxRows * ROW_HEIGHT_PX
    scrollRef.current.scrollTop = Math.max(0, top - scrollRef.current.clientHeight / 3)
    // Only when the shown week changes to include today — see HourGrid's identical note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorMs])

  const gridTemplateColumns = `${GUTTER_PX}px repeat(7, minmax(${MIN_COLUMN_PX}px, 1fr))`

  // All-day bars: reuse layoutOverlaps to stack overlapping multi-day events into rows —
  // "column" here becomes a vertical row index rather than a horizontal slot.
  const allDayPlacements = useMemo(() => {
    const items = allDayEvents
      .map((e) => {
        const span = allDayEventSpan(e, days)
        return span ? { id: `all-${e.id}`, startMs: span.startIndex, endMs: span.endIndex + 1, event: e } : null
      })
      .filter((x): x is { id: string; startMs: number; endMs: number; event: typeof allDayEvents[number] } => x !== null)
    return layoutOverlaps(items)
  }, [allDayEvents, days])
  const allDayRows = allDayPlacements.length > 0 ? Math.max(...allDayPlacements.map((p) => p.columns)) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="min-w-fit">
        {/* Column headers */}
        <div
          className="sticky top-0 z-20 grid border-b border-[var(--color-border)] bg-[var(--color-surface)]"
          style={{ gridTemplateColumns }}
        >
          <div />
          {days.map((d, i) => {
            const isToday = i === todayIndex
            return (
              <button
                key={d}
                type="button"
                onClick={() => onSelectDay(d)}
                aria-label={`Open ${formatColumnHeading(d)} in Day view`}
                className={`truncate px-1.5 py-2 text-center text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ${
                  isToday ? 'text-[var(--color-focus)]' : 'text-[var(--color-text)]'
                }`}
              >
                {formatColumnHeading(d)}
              </button>
            )
          })}
        </div>

        {/* All-day bars spanning the days they cover */}
        {allDayRows > 0 ? (
          <div
            className="sticky top-[33px] z-10 grid border-b border-[var(--color-border)] bg-[var(--color-surface)] py-1"
            style={{ gridTemplateColumns, gridAutoRows: '20px' }}
          >
            <div />
            <div className="relative col-span-7" style={{ height: `${allDayRows * 22}px` }}>
              {allDayPlacements.map(({ item, column }) => {
                const widthPct = 100 / 7
                return (
                  <span
                    key={item.id}
                    tabIndex={0}
                    title={item.event.title}
                    aria-label={`All-day: ${item.event.title}`}
                    className="absolute truncate rounded-md px-1.5 py-0.5 text-[10px] font-medium text-[#0a0d12] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40"
                    style={{
                      left: `${item.startMs * widthPct}%`,
                      width: `${(item.endMs - item.startMs) * widthPct}%`,
                      top: `${column * 22}px`,
                      backgroundColor: feedColors.get(item.event.feedId) ?? 'var(--color-focus)'
                    }}
                  >
                    {item.event.title}
                  </span>
                )
              })}
            </div>
          </div>
        ) : null}

        {/* Hour grid body */}
        <div
          ref={scrollRef}
          className="grid"
          style={{ gridTemplateColumns, height: `${maxRows * ROW_HEIGHT_PX}px` }}
        >
          <div className="relative border-r border-[var(--color-border)]">
            {Array.from({ length: maxRows }, (_, i) => (
              <div key={i} className="absolute inset-x-0 text-right" style={{ top: `${i * ROW_HEIGHT_PX - 6}px` }}>
                <span className="pr-1 text-[9px] text-[var(--color-text-muted)]">
                  {formatHourMark(i)}
                </span>
              </div>
            ))}
          </div>

          {days.map((d, i) => {
            const bounds = columnBounds[i]!
            const marks = hourMarks(bounds)
            const daySessions = sessionsByDay.get(toLocalDateKey(d)) ?? []
            const isToday = i === todayIndex
            const running = isToday ? runningBlock(timerState, projects, bounds) : null
            const blocks = [
              ...sessionBlocks(daySessions, projects, bounds),
              ...eventBlocks(calendarEvents, bounds, feedColors),
              ...(running ? [running] : [])
            ]
            const placements = layoutOverlaps(blocks)

            return (
              <div
                key={d}
                className="relative border-r border-[var(--color-border)]/60"
                style={{ height: `${marks.length * ROW_HEIGHT_PX}px` }}
              >
                {marks.map((_, mi) => (
                  <div
                    key={mi}
                    className="absolute inset-x-0 border-t border-[var(--color-border)]/40"
                    style={{ top: `${mi * ROW_HEIGHT_PX}px` }}
                  />
                ))}

                {placements.map(({ item, column, columns }) => (
                  <Block
                    key={item.id}
                    block={item}
                    column={column}
                    columns={columns}
                    startFraction={dayFraction(item.startMs, bounds)}
                    endFraction={dayFraction(item.endMs, bounds)}
                  />
                ))}

                {isToday && now >= bounds.start && now < bounds.end ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-[var(--color-danger)]"
                    style={{ top: `${dayFraction(now, bounds) * marks.length * ROW_HEIGHT_PX}px` }}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
