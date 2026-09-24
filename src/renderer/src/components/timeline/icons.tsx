/** Small inline icon set, matching the style of `components/timer/icons.tsx` and
 *  `components/stats/icons.tsx` — its own copy per this directory's ownership split. */

interface IconProps {
  className?: string
}

export function ChevronLeftIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.5 5 7.5 10l5 5" />
    </svg>
  )
}

export function ChevronRightIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.5 5l5 5-5 5" />
    </svg>
  )
}

export function CalendarEmptyIcon({ className = 'h-10 w-10' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3v3.5M16 3v3.5" />
    </svg>
  )
}

export function WarningIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
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
      <path d="M10 3 2.5 16.5h15Z" />
      <path d="M10 8v4" />
      <circle cx="10" cy="14.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  )
}
