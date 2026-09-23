import type { Settings } from '@shared/types'
import { DurationField } from '../DurationField'
import { NumberField } from '../NumberField'
import { Section } from '../ui'
import { Field, Select } from '../ui'

export function TimerSection({
  settings,
  set
}: {
  settings: Settings
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  return (
    <Section title="Timer" description="Which mode starts by default, and the Pomodoro clock.">
      <Field label="Default mode">
        <Select
          value={settings.mode}
          onChange={(v) => set({ mode: v as Settings['mode'] })}
        >
          <option value="flowmodoro">Flowmodoro</option>
          <option value="pomodoro">Pomodoro</option>
        </Select>
      </Field>

      <DurationField
        label="Focus length"
        valueMs={settings.pomodoroFocusMs}
        onCommit={(ms) => set({ pomodoroFocusMs: ms })}
      />
      <DurationField
        label="Short break length"
        valueMs={settings.pomodoroShortBreakMs}
        onCommit={(ms) => set({ pomodoroShortBreakMs: ms })}
      />
      <DurationField
        label="Long break length"
        valueMs={settings.pomodoroLongBreakMs}
        onCommit={(ms) => set({ pomodoroLongBreakMs: ms })}
      />
      <NumberField
        label="Long break every"
        hint="A long break replaces the short one after this many focus rounds."
        integer
        min={1}
        suffix="rounds"
        value={settings.longBreakEvery}
        onCommit={(v) => set({ longBreakEvery: v })}
      />
    </Section>
  )
}
