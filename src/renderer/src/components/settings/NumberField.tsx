/**
 * A plain numeric setting (the Flowmodoro divisor, the long-break interval) — no unit
 * conversion, but the same commit-on-blur validation as `DurationField` so a stray "0" or a
 * negative number never reaches `settings.set`.
 */

import { useEffect, useState } from 'react'
import { Field, TextInput } from './ui'

export interface NumberFieldProps {
  label: string
  hint?: string
  value: number
  onCommit: (value: number) => void
  min?: number
  max?: number
  /** Whole numbers only (e.g. "every N rounds"). Defaults to allowing decimals. */
  integer?: boolean
  suffix?: string
}

export function NumberField({
  label,
  hint,
  value,
  onCommit,
  min = 1,
  max,
  integer = false,
  suffix
}: NumberFieldProps): React.JSX.Element {
  const [text, setText] = useState(() => String(value))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setText(String(value))
    setError(null)
  }, [value])

  function commit(): void {
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) {
      setError('Enter a number.')
      return
    }
    if (integer && !Number.isInteger(parsed)) {
      setError('Enter a whole number.')
      return
    }
    if (parsed < min) {
      setError(`Enter at least ${min}.`)
      return
    }
    if (max !== undefined && parsed > max) {
      setError(`Enter at most ${max}.`)
      return
    }
    setError(null)
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-center gap-2">
        <TextInput
          inputMode={integer ? 'numeric' : 'decimal'}
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
        {suffix ? <span className="text-[11px] text-[var(--color-text-muted)]">{suffix}</span> : null}
      </div>
    </Field>
  )
}
