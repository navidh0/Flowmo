/**
 * The 220×88 always-on-top widget. A second renderer on the same store, so it shows exactly
 * what the main window shows and never needs a clock of its own.
 *
 * At this size everything is a subtraction: no dial (a ring plus legible digits does not fit in
 * 88px), no task title, no mode toggle. What survives is the phase, the time, the earned break,
 * a hairline progress bar, and two controls — which is what you glance at a widget for.
 *
 * The window is frameless, so the background must claim `-webkit-app-region: drag` or the user
 * cannot move it, and the controls must claim `no-drag` or their clicks are swallowed as the
 * start of a window drag.
 *
 * Frameless also means no title-bar close button, so the widget carries its own small X in the
 * top corner, set apart from the two controls so it can't be mistaken for Dismiss. It goes
 * through `app.setMiniWidget(false)`, the same path as the tray's toggle: that counts as the
 * user's explicit choice, so an auto-opened widget isn't reopened until the window next leaves.
 */

import type { CSSProperties } from 'react'
import { formatClock } from '../../lib/format'
import { IconButton } from '../timer/Button'
import {
  CoffeeIcon,
  PauseIcon,
  PlayIcon,
  SkipIcon,
  WarningIcon,
  XIcon
} from '../timer/icons'
import { readout } from '../timer/readout'
import {
  accentColor,
  canTakeBreak,
  isActive,
  isArmed,
  isRunning,
  phaseLabel,
  timerActions,
  useTimerStore,
  useTimerSync,
  ACCENT_BREAK
} from '../../stores/timer'

// `-webkit-app-region` is outside the CSS typings, and asserting is preferable to threading a
// class through Button's inline-style slot (which the accent fill already owns).
const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties

/** Ticks instead of a solid rail — the same "no fixed target" signal the dial's track uses. */
const OPEN_TRACK =
  'repeating-linear-gradient(90deg, var(--color-border) 0 3px, transparent 3px 8px)'

export function MiniWidget(): React.JSX.Element {
  useTimerSync()

  const state = useTimerStore((s) => s.state)
  const settings = useTimerStore((s) => s.settings)
  const ready = useTimerStore((s) => s.ready)

  const r = readout(state, settings)
  const accent = accentColor(state)
  const running = isRunning(state)
  const active = isActive(state)
  const armed = isArmed(state)
  const breakAvailable = canTakeBreak(state)
  const earned = state.earnedBreakMs

  // 'H:MM:SS' is two glyphs wider than 'MM:SS' and would push the controls off a 220px window.
  const timeClass = r.time.length > 5 ? 'text-[22px]' : 'text-[30px]'

  return (
    <div
      className="relative flex h-full w-full flex-col overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)]"
      style={DRAG}
    >
      <button
        type="button"
        aria-label="Close widget"
        title="Close the widget"
        onClick={() => void window.flowdo.app.setMiniWidget(false)}
        className="absolute right-1 top-1 z-10 grid h-4 w-4 place-items-center rounded text-[var(--color-text-muted)] opacity-60 outline-none transition-opacity hover:bg-[var(--color-surface-raised)] hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[var(--color-text-muted)]"
        style={NO_DRAG}
      >
        <XIcon className="h-2.5 w-2.5" />
      </button>
      <div className="flex flex-1 items-center gap-2 px-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
              {phaseLabel(state)}
            </span>
            {state.interrupted && active && (
              // Amber, matching the panel's interrupted note.
              <WarningIcon className="h-2.5 w-2.5 shrink-0 text-[var(--color-p2)]" />
            )}
            {earned != null && (
              <span
                className="ml-auto shrink-0 tabular text-[10px] font-semibold"
                style={{ color: ACCENT_BREAK }}
                title="Break earned so far"
              >
                +{formatClock(earned)}
              </span>
            )}
          </div>

          <div
            className={`tabular ${timeClass} mt-0.5 font-light leading-none tracking-tight`}
            style={{ color: r.muted ? 'var(--color-text-muted)' : 'var(--color-text)' }}
          >
            {r.time}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5" style={NO_DRAG}>
          <IconButton
            variant="primary"
            accent={accent}
            disabled={!ready}
            aria-label={running ? 'Pause' : 'Start'}
            title={running ? 'Pause' : active || armed ? 'Resume' : 'Start focus'}
            onClick={() => (running ? timerActions.pause() : timerActions.start())}
          >
            {running ? <PauseIcon /> : <PlayIcon />}
          </IconButton>

          {breakAvailable ? (
            <IconButton
              disabled={!ready}
              aria-label="Take a break"
              title="Take the earned break"
              onClick={() => timerActions.takeBreak()}
            >
              <CoffeeIcon className="h-4 w-4 text-[var(--color-break)]" />
            </IconButton>
          ) : armed ? (
            <IconButton
              disabled={!ready}
              aria-label="Dismiss"
              title="Dismiss the queued phase"
              onClick={() => timerActions.stop()}
            >
              <XIcon className="h-3.5 w-3.5" />
            </IconButton>
          ) : (
            <IconButton
              disabled={!ready || !active}
              aria-label="Skip"
              title="Skip to the next phase"
              onClick={() => timerActions.skip()}
            >
              <SkipIcon />
            </IconButton>
          )}
        </div>
      </div>

      <div
        className="h-[3px] w-full shrink-0"
        style={r.openEnded ? { backgroundImage: OPEN_TRACK } : { background: 'var(--color-border)' }}
      >
        <div
          className="h-full"
          style={{
            width: `${Math.min(100, Math.max(0, r.fraction * 100))}%`,
            background: accent,
            opacity: r.muted ? 0.5 : 1,
            transition: 'width 250ms linear'
          }}
        />
      </div>
    </div>
  )
}
