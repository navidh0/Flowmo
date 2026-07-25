/**
 * The timer surface: mode toggle, dial, controls, and the two mode-specific readouts.
 *
 * Composition only — every number comes from the store, which mirrors main. The one layout
 * decision worth naming is the fixed-height cue row above the dial: the ready pill and the
 * round dots come and go with the phase, and letting that shift a 264px dial up and down four
 * times a minute is the kind of motion a screen you stare at for hours cannot have.
 *
 * Subscription is per-component and deliberately narrow. `TimerDial` and `EarnedBreak` take the
 * whole state and therefore repaint on every tick; the panel, controls, dots, and chip select
 * booleans that only change at a phase boundary, so they do not.
 */

import {
  accentColor,
  isActive,
  isArmed,
  phaseLabel,
  phaseName,
  useTimerStore,
  useTimerSync
} from '../../stores/timer'
import { durationLabel, readout } from './readout'
import { Controls } from './Controls'
import { Dial } from './Dial'
import { EarnedBreak } from './EarnedBreak'
import { ModeToggle } from './ModeToggle'
import { RoundDots } from './RoundDots'
import { TaskChip } from './TaskChip'
import { WarningIcon } from './icons'

function TimerDial(): React.JSX.Element {
  const state = useTimerStore((s) => s.state)
  const settings = useTimerStore((s) => s.settings)

  const r = readout(state, settings)

  // The ticked track plus digits that climb needs one word of explanation, or an open-ended
  // focus looks like a countdown that failed to start.
  const caption = r.openEnded
    ? isActive(state)
      ? 'no fixed end'
      : null
    : isActive(state) && state.plannedMs != null
      ? `of ${durationLabel(state.plannedMs)}`
      : null

  return (
    <Dial
      accent={accentColor(state)}
      fraction={r.fraction}
      openEnded={r.openEnded}
      muted={r.muted}
      label={phaseLabel(state)}
      time={r.time}
      caption={caption}
    />
  )
}

/**
 * Armed: chosen, waiting, nothing accruing. The dimmed full ring alone could equally read as
 * "finished", so the pill states it, and the one slow-pulsing dot in the whole UI says the app
 * is waiting on the user rather than the other way round.
 */
function ReadyPill(): React.JSX.Element {
  const name = useTimerStore((s) => phaseName(s.state))
  const plannedMs = useTimerStore((s) => s.state.plannedMs)
  const accent = useTimerStore((s) => accentColor(s.state))

  return (
    <span
      className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px] font-medium"
      style={{
        color: accent,
        background: `color-mix(in srgb, ${accent} 12%, transparent)`
      }}
    >
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span
          className="absolute inset-0 animate-ping rounded-full opacity-75"
          style={{ background: accent }}
        />
        <span className="relative h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
      </span>
      {name} ready
      {plannedMs != null && plannedMs > 0 ? ` · ${durationLabel(plannedMs)}` : ''}
    </span>
  )
}

/** A slept-through gap was subtracted. Worth saying, not worth shouting. */
function InterruptedNote(): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px]"
      style={{ color: 'var(--color-p2)' }}
      title="This machine was asleep longer than the grace period, so that time was removed from the session."
    >
      <WarningIcon className="h-3.5 w-3.5" />
      Sleep gap removed from this session
    </span>
  )
}

export function TimerPanel(): React.JSX.Element {
  // Idempotent and reference-counted, so the panel stays self-sufficient whether or not the
  // shell already called it.
  useTimerSync()

  const pomodoro = useTimerStore((s) => s.state.mode === 'pomodoro')
  const armed = useTimerStore((s) => isArmed(s.state))
  const interrupted = useTimerStore((s) => s.state.interrupted && isActive(s.state))

  return (
    // Scroll on the outer box with `min-h-full` inside: centring content in a scroll container
    // directly would make the top of it unreachable once it overflows a short window.
    <div className="h-full w-full overflow-y-auto">
      <section className="flex min-h-full w-full flex-col items-center justify-center gap-4 px-6 py-5">
        <ModeToggle />

        <div className="flex h-7 shrink-0 items-center justify-center gap-4">
          {armed && <ReadyPill />}
          {pomodoro && <RoundDots />}
        </div>

        <TimerDial />

        <div className="flex flex-col items-center gap-3">
          {interrupted && <InterruptedNote />}
          <EarnedBreak />
          <Controls />
          <TaskChip />
        </div>
      </section>
    </div>
  )
}
