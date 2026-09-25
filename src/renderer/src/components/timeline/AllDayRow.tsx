/**
 * All-day events for this day, above the hour grid. A multi-day event is shown in EVERY
 * day it covers — `startDate`/`endDate` are local calendar days with `endDate` exclusive
 * (RFC 5545), so the day key just needs to fall in `[startDate, endDate)`.
 */

import type { CalendarEvent } from '@shared/types'
import { toLocalDateKey } from '@renderer/lib/format'
import { eventColor } from './blocks'

export interface AllDayRowProps {
  dayMs: number
  events: CalendarEvent[]
  /** feedId -> colour; falls back to the shared accent when a feed is unknown. */
  feedColors: Map<number, string>
}

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

export function AllDayRow({ dayMs, events, feedColors }: AllDayRowProps): React.JSX.Element | null {
  const items = allDayEventsForDay(events, dayMs)
  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 border-b border-[var(--color-border)] px-4 py-2">
      {items.map((e) => (
        <span
          key={e.id}
          tabIndex={0}
          title={e.location ? `${e.title} — ${e.location}` : e.title}
          aria-label={`All-day: ${e.title}`}
          className="truncate rounded-md px-2 py-1 text-[11px] font-medium text-[var(--color-on-accent)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40"
          style={{ backgroundColor: eventColor(e.feedId, feedColors) }}
        >
          {e.title}
        </span>
      ))}
    </div>
  )
}
