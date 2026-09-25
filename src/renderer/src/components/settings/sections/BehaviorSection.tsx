import type { Settings } from '@shared/types'
import { Button } from '@renderer/components/timer/Button'
import { playChime } from '@renderer/lib/sounds'
import { Section, ToggleRow } from '../ui'

/** Plays both phase-end chimes back to back, so the toggle isn't a decision made blind. */
function playBothChimes(): void {
  const first = playChime('toBreak')
  window.setTimeout(() => playChime('toFocus'), Math.round((first + 0.2) * 1000))
}

export function BehaviorSection({
  settings,
  set
}: {
  settings: Settings
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  return (
    <Section title="Behaviour" description="What happens automatically at the end of a phase.">
      <ToggleRow
        label="Auto-start breaks"
        hint="Begin the break the moment focus ends, with no click."
        checked={settings.autoStartBreaks}
        onChange={(v) => set({ autoStartBreaks: v })}
      />
      <ToggleRow
        label="Auto-start focus"
        hint="Begin the next focus round the moment a break ends."
        checked={settings.autoStartFocus}
        onChange={(v) => set({ autoStartFocus: v })}
      />
      <ToggleRow
        label="Notifications"
        hint="Show a system notification when a phase ends."
        checked={settings.notificationsEnabled}
        onChange={(v) => set({ notificationsEnabled: v })}
      />
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <ToggleRow
            label="Sound"
            hint="Play a chime when a phase finishes. Stopping or skipping one early stays silent."
            checked={settings.soundEnabled}
            onChange={(v) => set({ soundEnabled: v })}
          />
        </div>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={playBothChimes}>
          Test sound
        </Button>
      </div>
    </Section>
  )
}
