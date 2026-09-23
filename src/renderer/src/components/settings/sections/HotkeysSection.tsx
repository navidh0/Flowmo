import { useEffect, useState } from 'react'
import type { HotkeyFailure, Settings } from '@shared/types'
import { HotkeyField } from '../HotkeyField'
import { Section } from '../ui'

/** Keeps the failures list fresh: an initial fetch plus the push whenever main re-registers. */
function useHotkeyFailures(): HotkeyFailure[] {
  const [failures, setFailures] = useState<HotkeyFailure[]>([])

  useEffect(() => {
    let cancelled = false
    void window.flowdo.system.getHotkeyFailures().then((f) => {
      if (!cancelled) setFailures(f)
    })
    const off = window.flowdo.system.onHotkeyFailures((f) => setFailures(f))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return failures
}

export function HotkeysSection({
  settings,
  set
}: {
  settings: Settings
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  const failures = useHotkeyFailures()
  const startPauseFailure = failures.find((f) => f.action === 'startPause') ?? null
  const skipFailure = failures.find((f) => f.action === 'skip') ?? null

  return (
    <Section
      title="Hotkeys"
      description="Global shortcuts that work even when Flowdo isn't focused. Leave a field off to disable it."
    >
      <HotkeyField
        label="Start / pause"
        value={settings.hotkeyStartPause}
        conflictsWith={settings.hotkeySkip}
        activeFailure={startPauseFailure}
        onCommit={(accelerator) => set({ hotkeyStartPause: accelerator })}
      />
      <HotkeyField
        label="Skip"
        value={settings.hotkeySkip}
        conflictsWith={settings.hotkeyStartPause}
        activeFailure={skipFailure}
        onCommit={(accelerator) => set({ hotkeySkip: accelerator })}
      />
    </Section>
  )
}
