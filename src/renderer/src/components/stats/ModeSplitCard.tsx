/**
 * Pomodoro vs Flowmodoro, by time and by completed-session count. Two bars rather than one
 * stacked bar, because focus time and session count can disagree about which mode "won" —
 * a handful of long Flowmodoro stretches can outweigh many short Pomodoros in time while
 * losing on count, and collapsing that into one number would hide it.
 */

import type { ModeSplit, TimerMode } from '@shared/types'
import { formatDuration } from '@renderer/lib/format'

const MODE_LABEL: Record<TimerMode, string> = {
  pomodoro: 'Pomodoro',
  flowmodoro: 'Flowmodoro'
}

const MODE_COLOR: Record<TimerMode, string> = {
  pomodoro: 'var(--color-focus)',
  flowmodoro: 'var(--color-break)'
}

function Bar({
  mode,
  value,
  max,
  formatValue
}: {
  mode: TimerMode
  value: number
  max: number
  formatValue: (v: number) => string
}): React.JSX.Element {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-20 shrink-0 text-[12px] text-[var(--color-text-muted)]">
        {MODE_LABEL[mode]}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, backgroundColor: MODE_COLOR[mode] }}
        />
      </div>
      <span className="w-16 shrink-0 text-right text-[12px] tabular text-[var(--color-text)]">
        {formatValue(value)}
      </span>
    </div>
  )
}

export function ModeSplitCard({
  byMode
}: {
  byMode: Record<TimerMode, ModeSplit>
}): React.JSX.Element {
  const maxMs = Math.max(byMode.pomodoro.focusMs, byMode.flowmodoro.focusMs, 1)
  const maxSessions = Math.max(byMode.pomodoro.sessions, byMode.flowmodoro.sessions, 1)

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3.5 py-3">
      <h3 className="text-[12px] font-medium text-[var(--color-text)]">Pomodoro vs Flowmodoro</h3>
      <div className="mt-3 space-y-2">
        <Bar mode="pomodoro" value={byMode.pomodoro.focusMs} max={maxMs} formatValue={formatDuration} />
        <Bar
          mode="flowmodoro"
          value={byMode.flowmodoro.focusMs}
          max={maxMs}
          formatValue={formatDuration}
        />
      </div>
      <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
        <Bar
          mode="pomodoro"
          value={byMode.pomodoro.sessions}
          max={maxSessions}
          formatValue={(v) => String(v)}
        />
        <Bar
          mode="flowmodoro"
          value={byMode.flowmodoro.sessions}
          max={maxSessions}
          formatValue={(v) => String(v)}
        />
      </div>
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">Top: focus time. Bottom: sessions.</p>
    </div>
  )
}
