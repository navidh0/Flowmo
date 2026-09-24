/** Prev / Today / next (stepping by the current view's own unit), the view switcher, and
 *  the visible range as a readable heading. */

import { Button, IconButton } from '@renderer/components/timer/Button'
import { formatDayHeading, formatMonthHeading, formatWeekHeading } from './format'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'
import { monthGrid, localWeekBounds } from './layout'
import { ViewSwitcher } from './ViewSwitcher'
import type { ViewMode } from './views'

export interface HeaderProps {
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  anchorMs: number
  isToday: boolean
  onPrev: () => void
  onNext: () => void
  onToday: () => void
}

function heading(view: ViewMode, anchorMs: number): string {
  if (view === 'day') return formatDayHeading(anchorMs)
  if (view === 'week') {
    const { start, end } = localWeekBounds(anchorMs)
    return formatWeekHeading(start, end)
  }
  return formatMonthHeading(monthGrid(anchorMs).monthMs)
}

const PREV_LABEL: Record<ViewMode, string> = {
  day: 'Previous day',
  week: 'Previous week',
  month: 'Previous month'
}
const NEXT_LABEL: Record<ViewMode, string> = {
  day: 'Next day',
  week: 'Next week',
  month: 'Next month'
}

export function Header({
  view,
  onViewChange,
  anchorMs,
  isToday,
  onPrev,
  onNext,
  onToday
}: HeaderProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-1.5">
        <IconButton variant="secondary" aria-label={PREV_LABEL[view]} title={PREV_LABEL[view]} onClick={onPrev}>
          <ChevronLeftIcon />
        </IconButton>
        <Button variant="secondary" size="sm" onClick={onToday} disabled={isToday}>
          Today
        </Button>
        <IconButton variant="secondary" aria-label={NEXT_LABEL[view]} title={NEXT_LABEL[view]} onClick={onNext}>
          <ChevronRightIcon />
        </IconButton>
      </div>

      <h1 className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-[var(--color-text)]">
        {heading(view, anchorMs)}
      </h1>

      <ViewSwitcher value={view} onChange={onViewChange} />
    </div>
  )
}
