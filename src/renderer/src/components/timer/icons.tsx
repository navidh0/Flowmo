/**
 * Inline SVG glyphs. No icon dependency and no emoji — emoji render at the OS's whim and
 * carry a colour the design system doesn't control.
 *
 * All of them inherit `currentColor` and size from the caller's class.
 */

interface IconProps {
  className?: string
}

export function PlayIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4.5 2.4c0-.8.87-1.29 1.55-.88l7.2 4.4a1.03 1.03 0 0 1 0 1.76l-7.2 4.4A1.03 1.03 0 0 1 4.5 11.2V2.4Z" />
    </svg>
  )
}

export function PauseIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.2" height="11" rx="1.1" />
      <rect x="9.3" y="2.5" width="3.2" height="11" rx="1.1" />
    </svg>
  )
}

export function StopIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="2" />
    </svg>
  )
}

export function SkipIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3.2 3.1c0-.75.82-1.21 1.46-.83l6.1 3.62a.97.97 0 0 1 0 1.66l-6.1 3.62A.97.97 0 0 1 3.2 10.4V3.1Z" />
      <rect x="11.6" y="2.4" width="2.2" height="9.9" rx="1.1" />
    </svg>
  )
}

/** A mug — the break glyph. */
export function CoffeeIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 6.5h10v5a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4v-5Z" />
      <path d="M13.5 7.5h1.6a2.2 2.2 0 0 1 0 4.4h-1.6" />
      <path d="M6 3.6c0 .7.6.9.6 1.6M9.6 3.2c0 .8.7 1 .7 2" />
    </svg>
  )
}

export function XIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/** Concentric rings — "what you're aiming at", used on the task chip. */
export function TargetIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.8" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  )
}

export function WarningIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 2.6 1.9 13.2h12.2L8 2.6Z" />
      <path d="M8 6.4v3.2M8 11.4h.01" />
    </svg>
  )
}
