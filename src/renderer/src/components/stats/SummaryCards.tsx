/**
 * Headline numbers. `focusMs` and `focusSessions`/`avgFocusMs` are shown as separate cards
 * rather than reconciled with `actualPomodoros` anywhere on this row — `focusMs` counts
 * every minute spent including abandoned sessions, the per-mode split below counts only
 * completed pomodoros. Both are real answers to different questions.
 *
 * Auto-fit grid rather than a flex row: at the minimum main-panel width (280px) a fixed
 * five-across row has no room and truncates every label into ellipses, which is exactly the
 * "0 sessions, in…" illegibility this is meant to avoid. Letting cards wrap to more rows,
 * and letting labels/sublines wrap instead of truncate, keeps every card readable at any
 * width instead of merely at the width it happened to be designed against.
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
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--color-text-muted)]">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1.5 text-[20px] font-semibold leading-tight text-[var(--color-text)] tabular">
        {value}
      </div>
      {hint ? (
        <div className="mt-0.5 text-[11px] leading-snug text-[var(--color-text-muted)]">{hint}</div>
      ) : null}
    </div>
  )
}

export function SummaryCards({ summary }: { summary: StatsSummary }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2.5">
      <Card
        label="Focus time"
        value={formatDuration(summary.focusMs)}
        hint={`${summary.focusSessions} session${summary.focusSessions === 1 ? '' : 's'}, incl. abandoned`}
      />
      <Card
        label="Avg. session"
        value={formatDuration(summary.avgFocusMs)}
        hint="Mean of completed sessions only"
      />
      <Card label="Break time" value={formatDuration(summary.breakMs)} />
      <Card label="Tasks done" value={String(summary.completedTasks)} />
      <Card
        label="Streak"
        icon={<FlameIcon className="h-3 w-3 shrink-0 text-[var(--color-focus)]" />}
        value={`${summary.streakDays} day${summary.streakDays === 1 ? '' : 's'}`}
        hint="Consecutive days with a completed focus session"
      />
    </div>
  )
}
