/**
 * The day view: logged sessions and calendar events on one timeline for a single local day.
 *
 * Owns its own data lifecycle (init/dispose on mount/unmount), same as `StatsPage`, so it
 * can be dropped anywhere behind `React.lazy` without the shell knowing about
 * `stores/timeline`.
 */

import { useEffect, useMemo } from 'react'
import { Button } from '@renderer/components/timer/Button'
import { useTimelineStore } from '@renderer/stores/timeline'
import { useTimerStore } from '@renderer/stores/timer'
import { AllDayRow } from './AllDayRow'
import { eventBlocks, runningBlock, sessionBlocks } from './blocks'
import { EmptyDay } from './EmptyDay'
import { Header } from './Header'
import { HourGrid } from './HourGrid'
import { isSameLocalDay, localDayBounds } from './layout'
import { WarningIcon } from './icons'

function Skeleton(): React.JSX.Element {
  return (
    <div className="animate-pulse space-y-2.5 p-4">
      <div className="h-8 rounded-lg bg-[var(--color-surface-raised)]" />
      <div className="h-96 rounded-xl bg-[var(--color-surface-raised)]" />
    </div>
  )
}

export function TimelinePage(): React.JSX.Element {
  const dayMs = useTimelineStore((s) => s.dayMs)
  const sessions = useTimelineStore((s) => s.sessions)
  const calendarEvents = useTimelineStore((s) => s.calendarEvents)
  const calendarNote = useTimelineStore((s) => s.calendarNote)
  const feedColors = useTimelineStore((s) => s.feedColors)
  const projects = useTimelineStore((s) => s.projects)
  const loading = useTimelineStore((s) => s.loading)
  const ready = useTimelineStore((s) => s.ready)
  const error = useTimelineStore((s) => s.error)
  const init = useTimelineStore((s) => s.init)
  const dispose = useTimelineStore((s) => s.dispose)
  const goToday = useTimelineStore((s) => s.goToday)
  const goPrev = useTimelineStore((s) => s.goPrev)
  const goNext = useTimelineStore((s) => s.goNext)
  const refresh = useTimelineStore((s) => s.refresh)

  // Render-only: the running phase's own elapsed time comes verbatim from TimerState
  // (main-derived), never recomputed here — see CLAUDE.md.
  const timerState = useTimerStore((s) => s.state)

  useEffect(() => {
    void init()
    return () => dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    <div className="flex h-full min-h-0 flex-col">
      <Header dayMs={dayMs} isToday={isToday} onPrev={() => void goPrev()} onNext={() => void goNext()} onToday={() => void goToday()} />

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 border-b border-[var(--color-danger)]/35 bg-[color-mix(in_srgb,var(--color-danger)_12%,var(--color-surface-raised))] px-3 py-2"
        >
          <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-danger)]" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-[var(--color-text)]">
            {error}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      ) : null}

      {calendarNote ? (
        <p className="border-b border-[var(--color-border)] px-4 py-1.5 text-[11px] text-[var(--color-text-muted)]">
          {calendarNote}
        </p>
      ) : null}

      {!ready && loading ? (
        <Skeleton />
      ) : (
        <>
          <AllDayRow dayMs={dayMs} events={calendarEvents} feedColors={feedColors} />
          {isEmpty ? <EmptyDay /> : <HourGrid bounds={bounds} blocks={blocks} isToday={isToday} />}
        </>
      )}
    </div>
  )
}
