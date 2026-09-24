/**
 * The 00–24 hour grid: gridlines from `hourMarks` (DST-correct — see `layout.ts`), blocks
 * positioned by `dayFraction`, overlapping blocks laid out side by side by `layoutOverlaps`,
 * and a now-line when the day shown is today. Auto-scrolls to now once, on mount, for
 * today only — never on a past/future day, where "now" is off-grid or meaningless.
 */

import { useEffect, useRef, useState } from 'react'
import { dayFraction, hourMarks, layoutOverlaps, type DayBounds } from './layout'
import { formatHourLabel } from './format'
import { Block } from './Block'
import type { TimelineBlock } from './blocks'

/** Pixel height of one grid row. Fixed so the grid has a stable scroll length; never a
 *  fixed WIDTH, so the panel itself stays resizable. */
const ROW_HEIGHT_PX = 56

/** Refreshed every 30s — a light `setInterval` for the now-line's position, not a stand-in
 *  for the timer's own elapsed math (`TimerState.elapsedMs` is still rendered verbatim). */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [enabled])
  return now
}

export interface HourGridProps {
  bounds: DayBounds
  blocks: TimelineBlock[]
  isToday: boolean
}

export function HourGrid({ bounds, blocks, isToday }: HourGridProps): React.JSX.Element {
  const marks = hourMarks(bounds)
  const now = useNow(isToday)
  const scrollRef = useRef<HTMLDivElement>(null)
  const totalHeightPx = marks.length * ROW_HEIGHT_PX

  useEffect(() => {
    if (!isToday || !scrollRef.current) return
    const nowTop = dayFraction(now, bounds) * totalHeightPx
    const container = scrollRef.current
    // Centre-ish: a third of the way down, so there is visible context both before and
    // (mostly) after the current time.
    container.scrollTop = Math.max(0, nowTop - container.clientHeight / 3)
    // Only on mount / when the day flips to today — not on every 30s tick, or the view
    // would keep yanking itself back under the user's hands while they scroll to look at
    // something earlier.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isToday])

  const placements = layoutOverlaps(blocks)

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="relative flex" style={{ height: `${totalHeightPx}px` }}>
        <div className="w-12 shrink-0 border-r border-[var(--color-border)]">
          {marks.map((mark, i) => (
            <div
              key={i}
              className="relative text-right"
              style={{ height: `${ROW_HEIGHT_PX}px` }}
            >
              <span className="absolute -top-2 right-1.5 text-[10px] text-[var(--color-text-muted)]">
                {formatHourLabel(mark.hour)}
              </span>
            </div>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {marks.map((_, i) => (
            <div
              key={i}
              className="absolute inset-x-0 border-t border-[var(--color-border)]/60"
              style={{ top: `${(i / marks.length) * 100}%` }}
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
              style={{ top: `${dayFraction(now, bounds) * 100}%` }}
            >
              <span className="absolute -left-1.5 -top-[5px] h-2.5 w-2.5 rounded-full bg-[var(--color-danger)]" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
