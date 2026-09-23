import type { Settings } from '@shared/types'
import { DurationField } from '../DurationField'
import { NumberField } from '../NumberField'
import { Section } from '../ui'

export function FlowmodoroSection({
  settings,
  set
}: {
  settings: Settings
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  return (
    <Section
      title="Flowmodoro"
      description="Break earned is focus time divided by the divisor, clamped to the range below."
    >
      <NumberField
        label="Divisor"
        hint="flowmo.io uses 5 — 25 minutes of focus earns a 5-minute break."
        min={0.1}
        value={settings.flowmodoroDivisor}
        onCommit={(v) => set({ flowmodoroDivisor: v })}
      />
      <DurationField
        label="Minimum break"
        valueMs={settings.flowmodoroMinBreakMs}
        maxMinutes={settings.flowmodoroMaxBreakMs / 60_000}
        onCommit={(ms) => set({ flowmodoroMinBreakMs: ms })}
      />
      <DurationField
        label="Maximum break"
        valueMs={settings.flowmodoroMaxBreakMs}
        minMinutes={Math.max(1, settings.flowmodoroMinBreakMs / 60_000)}
        onCommit={(ms) => set({ flowmodoroMaxBreakMs: ms })}
      />
    </Section>
  )
}
