/**
 * Shell and routing. Owned by the integration layer — the UI agents own the components
 * under `components/`, this file only composes them.
 *
 * Wave 0 scope: proves the preload bridge and Tailwind pipeline work. Replaced with the
 * real shell (sidebar + timer + tasks + stats) as Wave 2 lands.
 */

import { useEffect, useState } from 'react'
import { computeEarnedBreakMs } from '@shared/timer-math'
import { DEFAULT_SETTINGS } from '@shared/types'
import { formatClock, formatDuration } from './lib/format'

export default function App(): React.JSX.Element {
  const [version, setVersion] = useState<string>('…')
  const [isMini, setIsMini] = useState<boolean | null>(null)

  useEffect(() => {
    void window.flowdo.app.getVersion().then(setVersion)
    void window.flowdo.app.isMiniWindow().then(setIsMini)
  }, [])

  // Sanity check that shared/ is reachable from the renderer and the math is sane:
  // 50 minutes of focus should earn a 10-minute break.
  const earned = computeEarnedBreakMs(50 * 60_000, DEFAULT_SETTINGS)

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="text-4xl font-semibold tracking-tight tabular">
        {formatClock(25 * 60_000)}
      </div>
      <div className="text-sm text-[var(--color-text-muted)]">
        Flowdo v{version} · bridge {isMini === null ? 'pending' : 'ok'} · mini={String(isMini)}
      </div>
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
        50m focus earns {formatDuration(earned)} break (divisor{' '}
        {DEFAULT_SETTINGS.flowmodoroDivisor})
      </div>
    </div>
  )
}
