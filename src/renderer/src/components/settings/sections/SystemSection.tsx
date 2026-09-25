import type { Settings } from '@shared/types'
import { NumberField } from '../NumberField'
import { Field, Select, Section, ToggleRow } from '../ui'

export function SystemSection({
  settings,
  set
}: {
  settings: Settings
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  return (
    <Section title="System" description="Tray, launch, the mini widget, and appearance.">
      <ToggleRow
        label="Minimize to tray"
        hint="Closing the window keeps Flowdo running in the background."
        checked={settings.minimizeToTray}
        onChange={(v) => set({ minimizeToTray: v })}
      />
      <ToggleRow
        label="Launch at login"
        checked={settings.launchAtLogin}
        onChange={(v) => set({ launchAtLogin: v })}
      />
      <ToggleRow
        label="Show mini widget"
        hint="A small always-on-top window with just the timer, kept open all the time."
        checked={settings.showMiniWidget}
        onChange={(v) => set({ showMiniWidget: v })}
      />
      <ToggleRow
        label="Mini widget when minimized"
        hint="When the main window is minimized or closed to the tray, the mini widget appears in the corner of the screen until you bring the window back. Drag it anywhere; it remembers the spot."
        checked={settings.miniWidgetOnMinimize}
        onChange={(v) => set({ miniWidgetOnMinimize: v })}
      />

      <Field label="Theme">
        <Select value={settings.theme} onChange={(v) => set({ theme: v as Settings['theme'] })}>
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </Select>
      </Field>

      <NumberField
        label="Sleep grace period"
        hint="A suspend longer than this marks the session interrupted, and subtracts the gap from focus time."
        min={0}
        suffix="minutes"
        value={settings.sleepGraceMs / 60_000}
        onCommit={(minutes) => set({ sleepGraceMs: Math.round(minutes * 60_000) })}
      />
    </Section>
  )
}
