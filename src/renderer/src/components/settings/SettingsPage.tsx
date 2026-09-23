/**
 * Settings screen. Default export so the shell can `React.lazy` it.
 *
 * Reads and writes through `useTimerStore` — `Settings` already lives there, kept fresh by
 * the `settings.onChange` subscription in `stores/timer.ts`. This component holds no copy of
 * its own; every field renders straight off the store and every commit is a `settings.set`
 * IPC call, so nothing here can drift out of sync with a second window doing the same.
 *
 * Sections are listed flat, one after another — appending the "Integrations" section a later
 * release adds (Todoist token, calendar URLs, sync status) is one more entry in this list.
 */

import { useCallback, useState } from 'react'
import type { Settings } from '@shared/types'
import { useTimerStore } from '@renderer/stores/timer'
import { BehaviorSection } from './sections/BehaviorSection'
import { DataSection } from './sections/DataSection'
import { FlowmodoroSection } from './sections/FlowmodoroSection'
import { HotkeysSection } from './sections/HotkeysSection'
import { LayoutSection } from './sections/LayoutSection'
import { SystemSection } from './sections/SystemSection'
import { TimerSection } from './sections/TimerSection'

export default function SettingsPage(): React.JSX.Element {
  const settings = useTimerStore((s) => s.settings)
  const [error, setError] = useState<string | null>(null)

  const set = useCallback((patch: Partial<Settings>) => {
    setError(null)
    void window.flowdo.settings.set(patch).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
        <h1 className="text-[14px] font-semibold text-[var(--color-text)]">Settings</h1>
      </header>

      {error ? (
        <p
          role="alert"
          className="shrink-0 border-b border-[var(--color-danger)]/35 bg-[color-mix(in_srgb,var(--color-danger)_12%,var(--color-surface-raised))] px-4 py-2 text-[12px] text-[var(--color-text)]"
        >
          Couldn&rsquo;t save that change: {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TimerSection settings={settings} set={set} />
        <FlowmodoroSection settings={settings} set={set} />
        <BehaviorSection settings={settings} set={set} />
        <SystemSection settings={settings} set={set} />
        <HotkeysSection settings={settings} set={set} />
        <LayoutSection set={set} />
        <DataSection />
      </div>
    </div>
  )
}
