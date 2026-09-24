/** The Day view's body: the all-day row and the 00–24 hour grid for a single local day. */

import { useMemo } from 'react'
import type { CalendarEvent, Project, Session, TimerState } from '@shared/types'
import { AllDayRow } from './AllDayRow'
import { eventBlocks, runningBlock, sessionBlocks } from './blocks'
import { EmptyDay } from './EmptyDay'
import { HourGrid } from './HourGrid'
import { isSameLocalDay, localDayBounds } from './layout'

export interface DayViewProps {
  dayMs: number
  sessions: Session[]
  calendarEvents: CalendarEvent[]
  feedColors: Map<number, string>
  projects: Project[]
  timerState: TimerState
  ready: boolean
}

export function DayView({
  dayMs,
  sessions,
  calendarEvents,
  feedColors,
  projects,
  timerState,
  ready
}: DayViewProps): React.JSX.Element {
  const bounds = useMemo(() => localDayBounds(dayMs), [dayMs])
  const isToday = useMemo(() => isSameLocalDay(Date.now(), dayMs), [dayMs])

  const blocks = useMemo(() => {
    const running = runningBlock(timerState, projects, bounds)
    return [
      ...sessionBlocks(sessions, projects, bounds),
      ...eventBlocks(calendarEvents, bounds, feedColors),
      ...(running ? [running] : [])
    ]
  }, [sessions, calendarEvents, feedColors, projects, bounds, timerState])

  const isEmpty = ready && blocks.length === 0 && calendarEvents.length === 0

  return (
    <>
      <AllDayRow dayMs={dayMs} events={calendarEvents} feedColors={feedColors} />
      {isEmpty ? <EmptyDay /> : <HourGrid bounds={bounds} blocks={blocks} isToday={isToday} />}
    </>
  )
}
