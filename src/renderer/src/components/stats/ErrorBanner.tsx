/**
 * The stats store's `error`, made visible. Same shape and reasoning as
 * `components/tasks/ErrorBanner.tsx` — kept as its own copy rather than a shared import so
 * this directory has no dependency on another agent's, per the ownership split.
 */

import { IconButton } from '@renderer/components/timer/Button'
import { WarningIcon, XIcon } from '@renderer/components/timer/icons'
import { useStatsStore } from '@renderer/stores/stats'

export function ErrorBanner(): React.JSX.Element | null {
  const error = useStatsStore((s) => s.error)
  const clearError = useStatsStore((s) => s.clearError)

  if (!error) return null

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 border-b border-[var(--color-danger)]/35 bg-[color-mix(in_srgb,var(--color-danger)_12%,var(--color-surface-raised))] px-3 py-2"
    >
      <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-danger)]" />
      <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-[var(--color-text)]">
        {error}
      </p>
      <IconButton
        variant="ghost"
        aria-label="Dismiss error"
        title="Dismiss"
        onClick={clearError}
        className="-my-0.5 h-6 w-6 shrink-0"
      >
        <XIcon />
      </IconButton>
    </div>
  )
}
