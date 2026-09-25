import { WEEKDAYS, type Settings, type Weekday } from '@shared/types'
import { Field, Section, Select } from '../ui'

/** 4 Jan 2026 is a Sunday, so `4 + i` walks Sunday(0)…Saturday(6) in `Weekday` order. */
function weekdayName(day: Weekday): string {
  return new Date(2026, 0, 4 + day).toLocaleDateString(undefined, { weekday: 'long' })
}

function isWeekday(value: number): value is Weekday {
  return (WEEKDAYS as readonly number[]).includes(value)
}

export function CalendarSection({
  settings,
  set
}: {
  settings: Settings
  set: (patch: Partial<Settings>) => void
}): React.JSX.Element {
  return (
    <Section title="Calendar" description="How the calendar lays out weeks.">
      <Field
        label="First day of the week"
        hint="Week and Month views and the Stats “This week” range start on this day."
      >
        <Select
          value={String(settings.weekStartsOn)}
          onChange={(v) => {
            const weekStartsOn = Number(v)
            if (!isWeekday(weekStartsOn)) return
            set({ weekStartsOn })
          }}
        >
          {WEEKDAYS.map((day) => (
            <option key={day} value={day}>
              {weekdayName(day)}
            </option>
          ))}
        </Select>
      </Field>
    </Section>
  )
}
