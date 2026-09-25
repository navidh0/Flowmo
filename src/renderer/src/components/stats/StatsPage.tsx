/**
 * The stats screen. Owns its own data lifecycle (init/dispose on mount/unmount) so it can be
 * dropped anywhere behind `React.lazy` without the shell knowing anything about `stores/stats`.
 *
 * Loading and error are handled inline rather than deferring to a suspense boundary: a
 * failed IPC call renders a retry, never a blank screen, and the initial load renders a
 * skeleton rather than `NaN`-filled cards.
 */

import { useEffect, useRef } from 'react'
import { useTimerStore } from '@renderer/stores/timer'
import { useStatsStore } from '@renderer/stores/stats'
import { Button } from '@renderer/components/timer/Button'
import { DailyChart } from './DailyChart'
import { EmptyState } from './EmptyState'
import { ErrorBanner } from './ErrorBanner'
import { ModeSplitCard } from './ModeSplitCard'
import { ProjectBreakdown } from './ProjectBreakdown'
import { RangeSwitcher } from './RangeSwitcher'
import { SessionHistory } from './SessionHistory'
import { SummaryCards } from './SummaryCards'

function Skeleton(): React.JSX.Element {
  return (
    <div className="animate-pulse space-y-2.5">
      <div className="h-20 rounded-xl bg-[var(--color-surface-raised)]" />
      <div className="h-56 rounded-xl bg-[var(--color-surface-raised)]" />
      <div className="h-40 rounded-xl bg-[var(--color-surface-raised)]" />
    </div>
  )
}

export function StatsPage(): React.JSX.Element {
  const range = useStatsStore((s) => s.range)
  const summary = useStatsStore((s) => s.summary)
  const daily = useStatsStore((s) => s.daily)
  const byProject = useStatsStore((s) => s.byProject)
  const history = useStatsStore((s) => s.history)
  const loading = useStatsStore((s) => s.loading)
  const ready = useStatsStore((s) => s.ready)
  const error = useStatsStore((s) => s.error)
  const init = useStatsStore((s) => s.init)
  const dispose = useStatsStore((s) => s.dispose)
  const setRange = useStatsStore((s) => s.setRange)
  const refresh = useStatsStore((s) => s.refresh)
  const removeSession = useStatsStore((s) => s.removeSession)

  useEffect(() => {
    void init()
    return () => dispose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "This week" is computed by main from settings.weekStartsOn — when the user changes it
  // while this screen is open, the range the summary/daily/history already show is stale.
  // Skip the first run so mounting doesn't double the initial `init()` fetch above.
  const weekStartsOn = useTimerStore((s) => s.settings.weekStartsOn)
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartsOn])

  const isEmpty = summary !== null && summary.focusSessions === 0 && byProject.length === 0

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <ErrorBanner />

      <div className="min-w-0 flex-1 space-y-3.5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <h1 className="text-[15px] font-semibold text-[var(--color-text)]">Stats</h1>
          <RangeSwitcher value={range} onChange={(r) => void setRange(r)} />
        </div>

        {!ready && loading ? <Skeleton /> : null}

        {ready && !summary && error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] px-6 py-14 text-center">
            <p className="text-[13px] text-[var(--color-text-muted)]">Could not load stats.</p>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        ) : null}

        {summary ? (
          isEmpty ? (
            <>
              <SummaryCards summary={summary} />
              <EmptyState range={range} />
            </>
          ) : (
            <>
              <SummaryCards summary={summary} />
              <DailyChart daily={daily} />
              <div className="grid min-w-0 grid-cols-1 gap-3.5 lg:grid-cols-2">
                <ProjectBreakdown byProject={byProject} />
                <ModeSplitCard byMode={summary.byMode} />
              </div>
              <SessionHistory sessions={history} onRemove={(id) => void removeSession(id)} />
            </>
          )
        ) : null}
      </div>
    </div>
  )
}
