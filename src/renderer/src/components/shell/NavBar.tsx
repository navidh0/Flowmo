/**
 * Screen switcher for the main window. A slim vertical rail rather than a top bar — at the
 * 760px minimum window width a horizontal bar competes with panel content for height, while
 * a rail only costs width, which the resizable columns already trade in.
 */

export type Screen = 'focus' | 'day' | 'stats' | 'settings'

export interface NavBarProps {
  current: Screen
  onNavigate: (screen: Screen) => void
}

const ITEMS: { screen: Screen; label: string; icon: (className: string) => React.JSX.Element }[] = [
  { screen: 'focus', label: 'Focus', icon: (c) => <FocusIcon className={c} /> },
  { screen: 'day', label: 'Day', icon: (c) => <DayIcon className={c} /> },
  { screen: 'stats', label: 'Stats', icon: (c) => <StatsIcon className={c} /> },
  { screen: 'settings', label: 'Settings', icon: (c) => <SettingsIcon className={c} /> }
]

export function NavBar({ current, onNavigate }: NavBarProps): React.JSX.Element {
  return (
    <nav
      className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--color-border)] bg-[var(--color-surface-sunken)] py-3"
      aria-label="Main navigation"
    >
      {ITEMS.map(({ screen, label, icon }) => {
        const isActive = screen === current
        return (
          <button
            key={screen}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            aria-label={label}
            title={label}
            onClick={() => onNavigate(screen)}
            className={
              'flex h-10 w-10 items-center justify-center rounded-lg outline-none transition-colors ' +
              'focus-visible:ring-2 focus-visible:ring-[var(--color-text-muted)]/40 ' +
              (isActive
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-focus)]'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]')
            }
          >
            {icon('h-5 w-5')}
          </button>
        )
      })}
    </nav>
  )
}

interface IconProps {
  className?: string
}

function FocusIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

function DayIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
      <path d="M7 3v3M13 3v3M3.5 8.5h13M7 12h3.5" />
    </svg>
  )
}

function StatsIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M4.5 16V10.5M10 16V4.5M15.5 16v-8" />
    </svg>
  )
}

function SettingsIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.8v2.1M10 15.1v2.1M17.2 10h-2.1M4.9 10H2.8M14.9 5.1l-1.5 1.5M6.6 13.4l-1.5 1.5M14.9 14.9l-1.5-1.5M6.6 6.6 5.1 5.1" />
    </svg>
  )
}
