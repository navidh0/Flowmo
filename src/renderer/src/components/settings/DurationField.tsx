/**
 * A duration setting, stored in the backing `Settings` object as milliseconds but edited by
 * the user in minutes.
 *
 * Commits on blur or Enter rather than on every keystroke: settings.set is a real IPC round
 * trip, and firing it after every digit would make typing "15" briefly persist "1". While the
 * field holds a value that would resolve to zero, negative, or non-numeric milliseconds, the
 * bad value is shown as an inline error and never reaches `settings.set` — the repo layer
 * would silently fall back to a default, which is worse than a visible rejection.
 */

import { useEffect, useState } from 'react'
import { Field, TextInput } from './ui'

export interface DurationFieldProps {
  label: string
  hint?: string
  /** Current value, milliseconds. */
  valueMs: number
  /** Called only with a validated, positive millisecond value. */
  onCommit: (ms: number) => void
  /** Smallest allowed value in minutes. Defaults to a hair above zero. */
  minMinutes?: number
  maxMinutes?: number
}

function msToMinutesText(ms: number): string {
  const minutes = ms / 60_000
  // Keep it readable: whole minutes print without decimals, fractional ones keep two.
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2)
}

export function DurationField({
  label,
  hint,
  valueMs,
  onCommit,
  minMinutes = 1,
  maxMinutes
}: DurationFieldProps): React.JSX.Element {
  const [text, setText] = useState(() => msToMinutesText(valueMs))
  const [error, setError] = useState<string | null>(null)

  // The store is the source of truth; if another window (or a rejected commit) changes it,
  // reflect that once the field isn't mid-edit.
  useEffect(() => {
    setText(msToMinutesText(valueMs))
    setError(null)
  }, [valueMs])

  function commit(): void {
    const minutes = Number(text)
    if (!Number.isFinite(minutes) || minutes < minMinutes) {
      setError(`Enter at least ${minMinutes} minute${minMinutes === 1 ? '' : 's'}.`)
      return
    }
    if (maxMinutes !== undefined && minutes > maxMinutes) {
      setError(`Enter at most ${maxMinutes} minutes.`)
      return
    }
    const ms = Math.round(minutes * 60_000)
    if (ms <= 0) {
      setError('Duration must be greater than zero.')
      return
    }
    setError(null)
    if (ms !== valueMs) onCommit(ms)
  }

  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-center gap-2">
        <TextInput
          inputMode="decimal"
          value={text}
          className="max-w-[7rem]"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <span className="text-[11px] text-[var(--color-text-muted)]">minutes</span>
      </div>
    </Field>
  )
}
