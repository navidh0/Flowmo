/**
 * Headline numbers. `focusMs` and `focusSessions`/`avgFocusMs` are shown as separate cards
 * rather than reconciled with `actualPomodoros` anywhere on this row — `focusMs` counts
 * every minute spent including abandoned sessions, the per-mode split below counts only
 * completed pomodoros. Both are real answers to different questions.
 */

import type { StatsSummary } from '@shared/types'
import { formatDuration } from '@renderer/lib/format'
import { FlameIcon } from './icons'

interface CardProps {
  label: string
  value: string
  hint?: string
  icon?: React.JSX.Element
}

function Card({ label, value, hint, icon }: CardProps): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 truncate text-[20px] font-semibold leading-tight text-[var(--color-text)] tabular">
        {value}
      </div>
      {hint ? (
        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{hint}</div>
      ) : null}
    </div>
  )
}

export function SummaryCards({ summary }: { summary: StatsSummary }): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2.5">
      <Card
        label="Focus time"
        value={formatDuration(summary.focusMs)}
        hint={`${summary.focusSessions} session${summary.focusSessions === 1 ? '' : 's'}, incl. abandoned`}
      />
      <Card label="Avg. completed session" value={formatDuration(summary.avgFocusMs)} />
      <Card label="Break time" value={formatDuration(summary.breakMs)} />
      <Card label="Tasks completed" value={String(summary.completedTasks)} />
      <Card
        label="Streak"
        icon={<FlameIcon className="h-3 w-3 text-[var(--color-focus)]" />}
        value={`${summary.streakDays} day${summary.streakDays === 1 ? '' : 's'}`}
        hint="Consecutive days with a completed focus session"
      />
    </div>
  )
}
