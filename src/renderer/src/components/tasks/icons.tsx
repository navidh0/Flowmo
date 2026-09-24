/**
 * Glyphs the task surface needs and the timer surface does not.
 *
 * Deliberately additive to `components/timer/icons.tsx` rather than a copy of it —
 * `XIcon`, `TargetIcon`, and `WarningIcon` are imported from there so the same shape means
 * the same thing on both halves of the window. Everything here inherits `currentColor` and
 * takes its size from the caller's class, same as those.
 */

interface IconProps {
  className?: string
}

export function PlusIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
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
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  )
}

export function CheckIcon({ className = 'h-3 w-3' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.4 8.6l3 3 6.2-7" />
    </svg>
  )
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

export function PencilIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
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
      <path d="M10.6 2.9l2.5 2.5-7.3 7.3-3.1.6.6-3.1 7.3-7.3Z" />
      <path d="M9.2 4.3l2.5 2.5" />
    </svg>
  )
}

/** Six dots — the universal "pick this up and move it" affordance. */
export function GripIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="6" cy="4" r="1.2" />
      <circle cx="10" cy="4" r="1.2" />
      <circle cx="6" cy="8" r="1.2" />
      <circle cx="10" cy="8" r="1.2" />
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="10" cy="12" r="1.2" />
    </svg>
  )
}

export function ChevronIcon({
  className = 'h-3.5 w-3.5',
  open = false
}: IconProps & { open?: boolean }): React.JSX.Element {
  return (
    <svg
      className={`${className} transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.6L10.4 8 6 12.4" />
    </svg>
  )
}

export function CalendarIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2.4" y="3.4" width="11.2" height="10.2" rx="1.8" />
      <path d="M2.4 6.6h11.2M5.6 2.2v2.2M10.4 2.2v2.2" />
    </svg>
  )
}

export function ClockIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="5.9" />
      <path d="M8 4.6V8l2.4 1.6" />
    </svg>
  )
}

/** Stacked checklist lines — the subtask count marker. */
export function ChecklistIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
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
      <path d="M2.4 4.6l1.5 1.5 2.4-2.6M2.4 11.2l1.5 1.5 2.4-2.6" />
      <path d="M8.6 4.9h5M8.6 11.5h5" />
    </svg>
  )
}

/** Layered sheets — the "All tasks" entry. */
export function StackIcon({ className = 'h-4 w-4' }: IconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.9 14 5 8 8.1 2 5l6-3.1Z" />
      <path d="M2 8.4l6 3.1 6-3.1M2 11.4l6 3.1 6-3.1" />
    </svg>
  )
}

/**
 * Rounded check-mark badge — the source marker for anything synced from Todoist. Deliberately
 * not the Todoist wordmark/logo, just a small "this came from somewhere else" glyph.
 */
export function TodoistIcon({ className = 'h-3 w-3' }: IconProps): React.JSX.Element {
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
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3.2" />
      <path d="M5 8.1l1.9 1.9L11 6" />
    </svg>
  )
}

/** Two curved arrows chasing each other — a recurring task, or "advance to next occurrence". */
export function RepeatIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
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
      <path d="M3.1 7.3V5.6a2.5 2.5 0 0 1 2.5-2.5h6.7" />
      <path d="M10.4 1.4l1.9 1.7-1.9 1.7" />
      <path d="M12.9 8.7v1.7a2.5 2.5 0 0 1-2.5 2.5H3.7" />
      <path d="M5.6 14.6l-1.9-1.7 1.9-1.7" />
    </svg>
  )
}

/** Arrow breaking out of a box — "open this elsewhere", used for "Open in Todoist". */
export function ExternalLinkIcon({ className = 'h-3.5 w-3.5' }: IconProps): React.JSX.Element {
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
      <path d="M6.6 3.2H3.6a1 1 0 0 0-1 1v8.2a1 1 0 0 0 1 1h8.2a1 1 0 0 0 1-1v-3" />
      <path d="M9.2 2.4h4.4v4.4M13.4 2.6L7.6 8.4" />
    </svg>
  )
}

/** An empty list, for the "no tasks yet" state. */
export function EmptyListIcon({ className = 'h-8 w-8' }: IconProps): React.JSX.Element {
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
      <rect x="4.5" y="5.5" width="23" height="21" rx="3.5" />
      <path d="M9.5 12.5h9M9.5 17.5h13M9.5 22.5h6" strokeDasharray="2 3" />
    </svg>
  )
}
