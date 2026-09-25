/**
 * The always-on-top widget, 220×88 by default and user-resizable up to 480×200
 * (`MINI_SIZE`/`MINI_MAX_SIZE` in `src/main/windows.ts`).
 *
 * At the default size everything is a subtraction: no dial (a ring plus legible digits does
 * not fit in 88px), no task title, no mode toggle. What survives is the phase, the time, the
 * earned break, a hairline progress bar, and two controls — which is what you glance at a
 * widget for. Given more room, two things grow: the countdown digits (continuously, via a
 * `clamp()` keyed off `cqi`/`cqb` container-query units so the size tracks whichever of width
 * or height is tighter — see `timeClass` below) and, once the widget is tall enough, a second
 * line showing the attached task's title (a `@container` min-height variant, `MIN_HEIGHT_FOR_TASK`).
 * The root carries `@container-size` (`container-type: size`) so both axes are queryable.
 *
 * The window is frameless, so the background must claim `-webkit-app-region: drag` or the user
 * cannot move it, and the controls must claim `no-drag` or their clicks are swallowed as the
 * start of a window drag. A resizable frameless window relies on the OS/window manager to turn
 * a mouse-down near an edge into a resize instead of a move; on Linux that hit-testing is easy
 * to lose entirely to a drag region covering the whole window (there is no automatic native
 * resize border the way there is on Windows/macOS), so a thin (`EDGE_MARGIN`) strip along each
 * edge is carved out as `no-drag` to give the window manager a chance to see the edge. It costs
 * a few px of the "whole widget drags" affordance everywhere, in exchange for edges that are
 * resizable everywhere.
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
import { useCurrentTask } from '../timer/useCurrentTask'
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

/** Width of the non-drag resize strip carved out of each edge — see the header comment. */
const EDGE_MARGIN = 'h-1.5'
const EDGE_MARGIN_SIDE = 'w-1.5'

/**
 * Below this container height (comfortably above the 88px default, well under the 200px max)
 * there isn't room for a third line without crowding the controls, so the task title stays
 * hidden. Written in the same `@[34rem]`-style raw container-query syntax the tasks panel uses
 * (`src/renderer/src/components/tasks/index.tsx`), just keyed on height instead of width.
 */
const MIN_HEIGHT_FOR_TASK = '[@container(min-height:8rem)]:block'

/**
 * The countdown's font size, continuous rather than stepped: a `clamp()` between the exact
 * default-size value and a generous max, driven by `min(A·cqi, B·cqb)` — the SMALLER of a
 * width-keyed and a height-keyed term. Using `min()` of both axes (rather than either alone)
 * means the digits only grow once BOTH dimensions have grown: widening the widget without
 * making it taller (or vice versa) leaves the digits at their floor, which is what keeps this
 * safe at every corner of [MINI_SIZE, MINI_MAX_SIZE] — at the default 220×88 both terms are
 * chosen to sit under the floor, so the value is exactly the old fixed size, pixel for pixel.
 */
const TIME_CLASS_SHORT = 'text-[clamp(1.875rem,min(12cqi,30cqb),4rem)]' // 'MM:SS' — was 30px
const TIME_CLASS_LONG = 'text-[clamp(1.375rem,min(9cqi,22cqb),3rem)]' // 'H:MM:SS' — was 22px

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
  const { task } = useCurrentTask()

  // 'H:MM:SS' is two glyphs wider than 'MM:SS' and would push the controls off a 220px window.
  const timeClass = r.time.length > 5 ? TIME_CLASS_LONG : TIME_CLASS_SHORT

  return (
    <div
      className="@container-size relative flex h-full w-full flex-col overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)]"
      style={DRAG}
    >
      {/* Non-drag resize strips — see the header comment on EDGE_MARGIN. Sized well under the
          controls' own padding (px-2.5) so they never sit over a clickable control. */}
      <div className={`absolute inset-x-0 top-0 ${EDGE_MARGIN} cursor-ns-resize`} style={NO_DRAG} />
      <div className={`absolute inset-x-0 bottom-0 ${EDGE_MARGIN} cursor-ns-resize`} style={NO_DRAG} />
      <div className={`absolute inset-y-0 left-0 ${EDGE_MARGIN_SIDE} cursor-ew-resize`} style={NO_DRAG} />
      <div className={`absolute inset-y-0 right-0 ${EDGE_MARGIN_SIDE} cursor-ew-resize`} style={NO_DRAG} />

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

          {task && (
            // Hidden below MIN_HEIGHT_FOR_TASK, so at the 220×88 default nothing changes.
            <div
              className={`mt-0.5 hidden truncate text-[10px] text-[var(--color-text-muted)] ${MIN_HEIGHT_FOR_TASK}`}
              title={task.title}
            >
              {task.title}
            </div>
          )}
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
