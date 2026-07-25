/**
 * The one button in the timer surface.
 *
 * `primary` takes its fill from the live phase accent, which is passed in rather than read
 * from a class because it alternates between `--color-focus` and `--color-break` at
 * runtime. A disabled primary drops the inline fill entirely — an accent-coloured button at
 * 40% opacity still reads as pressable, and a control that looks live but isn't is worse
 * than no control.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** CSS colour for the `primary` fill. Ignored by the other variants. */
  accent?: string
  icon?: ReactNode
}

const BASE =
  'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full ' +
  'font-medium outline-none transition-[background-color,border-color,color,transform,opacity] ' +
  'duration-150 focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ' +
  'enabled:active:scale-[0.97] disabled:cursor-not-allowed'

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[12px]',
  md: 'h-10 px-4 text-[13px]',
  lg: 'h-12 px-7 text-[15px]'
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'text-[#0a0d12]',
  secondary:
    'border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text)] ' +
    'enabled:hover:border-[#39414f] enabled:hover:bg-[#1e222b] disabled:opacity-40',
  ghost:
    'text-[var(--color-text-muted)] enabled:hover:bg-[var(--color-surface-raised)] ' +
    'enabled:hover:text-[var(--color-text)] disabled:opacity-40',
  danger:
    'text-[var(--color-text-muted)] enabled:hover:bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] ' +
    'enabled:hover:text-[var(--color-danger)] disabled:opacity-40'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  accent,
  icon,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  const isPrimary = variant === 'primary'

  const primaryClasses = disabled
    ? 'border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] opacity-60'
    : `${VARIANTS.primary} enabled:hover:brightness-110`

  return (
    <button
      type={type}
      disabled={disabled}
      className={`${BASE} ${SIZES[size]} ${isPrimary ? primaryClasses : VARIANTS[variant]} ${className}`}
      style={isPrimary && !disabled ? { backgroundColor: accent ?? 'var(--color-focus)' } : undefined}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

/** Square icon-only button, for the mini widget where there is no room for labels. */
export function IconButton({
  variant = 'secondary',
  accent,
  children,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: Omit<ButtonProps, 'size' | 'icon'>): React.JSX.Element {
  const isPrimary = variant === 'primary'

  const primaryClasses = disabled
    ? 'border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] opacity-60'
    : `${VARIANTS.primary} enabled:hover:brightness-110`

  return (
    <button
      type={type}
      disabled={disabled}
      className={`${BASE} h-8 w-8 rounded-lg p-0 ${isPrimary ? primaryClasses : VARIANTS[variant]} ${className}`}
      style={isPrimary && !disabled ? { backgroundColor: accent ?? 'var(--color-focus)' } : undefined}
      {...rest}
    >
      {children}
    </button>
  )
}
