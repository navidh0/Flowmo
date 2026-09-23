import type { Settings } from '@shared/types'
import { Section, ToggleRow } from '../ui'

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
      <ToggleRow
        label="Sound"
        hint="Play a chime when a phase ends."
        checked={settings.soundEnabled}
        onChange={(v) => set({ soundEnabled: v })}
      />
    </Section>
  )
}
