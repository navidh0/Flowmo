/** Segmented today/week/year/all control. Wraps rather than truncates at narrow widths. */

import type { StatsRange } from '@shared/types'

const RANGES: Array<{ value: StatsRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' }
]

export interface RangeSwitcherProps {
  value: StatsRange
  onChange: (range: StatsRange) => void
}

export function RangeSwitcher({ value, onChange }: RangeSwitcherProps): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Stats range"
      className="inline-flex flex-wrap gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-1"
    >
      {RANGES.map((r) => {
        const active = r.value === value
        return (
          <button
            key={r.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(r.value)}
            className={`rounded-full px-3 py-1.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ${
              active
                ? 'bg-[var(--color-focus)] text-[var(--color-on-accent)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {r.label}
          </button>
        )
      })}
    </div>
  )
}
