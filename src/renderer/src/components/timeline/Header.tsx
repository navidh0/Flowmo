/** Prev / Today / next, and the day as a readable date. */

import { Button, IconButton } from '@renderer/components/timer/Button'
import { formatDayHeading } from './format'
import { ChevronLeftIcon, ChevronRightIcon } from './icons'

export interface HeaderProps {
  dayMs: number
  isToday: boolean
  onPrev: () => void
  onNext: () => void
  onToday: () => void
}

export function Header({ dayMs, isToday, onPrev, onNext, onToday }: HeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2.5 border-b border-[var(--color-border)] px-4 py-3">
      <div className="flex items-center gap-1.5">
        <IconButton
          variant="secondary"
          aria-label="Previous day"
          title="Previous day"
          onClick={onPrev}
        >
          <ChevronLeftIcon />
        </IconButton>
        <Button variant="secondary" size="sm" onClick={onToday} disabled={isToday}>
          Today
        </Button>
        <IconButton variant="secondary" aria-label="Next day" title="Next day" onClick={onNext}>
          <ChevronRightIcon />
        </IconButton>
      </div>
      <h1 className="min-w-0 flex-1 truncate text-right text-[13px] font-medium text-[var(--color-text)]">
        {formatDayHeading(dayMs)}
      </h1>
    </div>
  )
}
