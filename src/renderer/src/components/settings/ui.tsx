/**
 * Form primitives shared by every settings section.
 *
 * Sections are plain components rendered one after another in `SettingsPage` — appending a
 * future section (Integrations) means adding one more `<Section>` to that list, never
 * restructuring these primitives.
 */

import type { ReactNode } from 'react'
import { FIELD } from '@renderer/components/tasks/ui'

export function Section({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="border-b border-[var(--color-border)] px-4 py-5 last:border-b-0">
      <h2 className="text-[13px] font-semibold text-[var(--color-text)]">{title}</h2>
      {description ? (
        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          {description}
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  )
}

/**
 * Label + control + optional error, stacked. Never a fixed-width two-column grid — panels
 * are user-resizable down to a narrow minimum, and a label column that doesn't wrap breaks
 * first.
 */
export function Field({
  label,
  hint,
  error,
  children
}: {
  label: string
  hint?: string
  error?: string | null
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-[12px] text-[var(--color-text)]">
        {label}
      </span>
      {children}
      {hint && !error ? (
        <span className="text-[11px] text-[var(--color-text-muted)]">{hint}</span>
      ) : null}
      {error ? <span className="text-[11px] text-[var(--color-danger)]">{error}</span> : null}
    </label>
  )
}

export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md py-0.5 text-[12px] text-[var(--color-text)]">
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {hint ? (
          <span className="text-[11px] font-normal text-[var(--color-text-muted)]">{hint}</span>
        ) : null}
      </span>
      <span
        role="switch"
        aria-checked={checked}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-[var(--color-border)] transition-colors"
        style={{ backgroundColor: checked ? 'var(--color-focus)' : 'var(--color-surface-sunken)' }}
      >
        <input
          type="checkbox"
          className="absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className="pointer-events-none absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-[left]"
          style={{ left: checked ? '18px' : '2px' }}
        />
      </span>
    </label>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  const { className = '', ...rest } = props
  return <input className={`${FIELD} ${className}`} {...rest} />
}

export function Select({
  value,
  onChange,
  children,
  disabled
}: {
  value: string
  onChange: (value: string) => void
  children: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <select
      className={FIELD}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  )
}
