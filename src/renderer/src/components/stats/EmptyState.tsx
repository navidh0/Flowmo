/** Zero sessions in the selected range. An invitation, not a blank chart with no axes. */

import { EmptyChartIcon } from './icons'

export function EmptyState({ range }: { range: string }): React.JSX.Element {
  const period = range === 'today' ? 'today' : range === 'week' ? 'this week' : range === 'year' ? 'this year' : 'yet'

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--color-border)] px-6 py-10 text-center">
      <EmptyChartIcon className="h-10 w-10 shrink-0 text-[var(--color-text-muted)]" />
      <div>
        <p className="text-[13px] font-medium text-[var(--color-text)]">No sessions {period}</p>
        <p className="mt-1 text-[12px] text-[var(--color-text-muted)]">
          Start a focus session and it will show up here.
        </p>
      </div>
    </div>
  )
}
