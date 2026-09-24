/**
 * Day / Week / Month segmented control. The choice lives in the timeline store's `view`
 * field (session-only — never written to settings; see `stores/timeline.ts`), and this
 * component is a pure function of the `value` prop: which segment is highlighted is always
 * `isViewActive(option, value)`, the same equality check driving both the visible style and
 * `aria-checked`, so the two can never disagree.
 */

import { isViewActive, VIEW_MODES, type ViewMode } from './views'

export interface ViewSwitcherProps {
  value: ViewMode
  onChange: (view: ViewMode) => void
}

const LABEL: Record<ViewMode, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month'
}

export function ViewSwitcher({ value, onChange }: ViewSwitcherProps): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Timeline view"
      className="inline-flex shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-0.5"
    >
      {VIEW_MODES.map((option) => {
        const active = isViewActive(option, value)
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex, as an ARIA radiogroup expects: only the checked segment sits
            // in the tab order, so Tab moves past the whole group in one stop.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option)}
            className={
              'rounded-md px-2.5 py-1 text-[12px] font-medium outline-none transition-colors ' +
              'focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ' +
              (active
                ? 'bg-[var(--color-surface)] text-[var(--color-text)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]')
            }
          >
            {LABEL[option]}
          </button>
        )
      })}
    </div>
  )
}
