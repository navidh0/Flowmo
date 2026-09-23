/**
 * Glyphs the stats surface needs and the timer surface does not. Same convention as
 * `components/tasks/icons.tsx`: inherit `currentColor`, size from the caller's class,
 * no emoji.
 */

interface IconProps {
  className?: string
}

export function TrashIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.8 4.4h10.4M6.2 4.4V3.1h3.6v1.3M4.2 4.4l.6 8.1a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.1" />
      <path d="M6.7 6.9v4M9.3 6.9v4" />
    </svg>
  )
}

/** Streak marker. */
export function FlameIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.2c.4 2 2.6 3 2.6 5.6a2.6 2.6 0 1 1-5.2 0c0-.7.2-1.2.5-1.7-.9.6-1.7 1.9-1.7 3.4a3.8 3.8 0 1 0 7.6 0c0-3.4-2.4-4.9-3.8-7.3Z" />
    </svg>
  )
}

/** Bar chart glyph for the "no sessions yet" empty state. */
export function EmptyChartIcon({ className = 'h-8 w-8' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 27V5M5 27h22" />
      <rect x="9" y="18" width="3.5" height="9" rx="1" />
      <rect x="15" y="12" width="3.5" height="15" rx="1" />
      <rect x="21" y="16" width="3.5" height="11" rx="1" />
    </svg>
  )
}
