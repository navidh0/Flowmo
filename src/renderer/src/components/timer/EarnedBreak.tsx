/**
 * The Flowmodoro payoff: the break you have earned so far, ticking up while you focus.
 *
 * This is the number that makes the mode work — the reason to keep going is watching it grow —
 * so it gets its own card, its own accent, and a type size close to the dial's rather than a
 * line of small print under the controls.
 *
 * The hint on the right exists because the formula clamps: for the first `divisor × min` of a
 * session the earned break sits still at the minimum, and a number that refuses to move with
 * no explanation reads as broken.
 */

import { formatClock } from '../../lib/format'
import { canTakeBreak, useTimerStore } from '../../stores/timer'
import { durationLabel } from './readout'

export function EarnedBreak(): React.JSX.Element | null {
  const show = useTimerStore((s) => canTakeBreak(s.state))
  // `state` is one stable object per broadcast, so this re-renders on ticks (which is the
  // point) without handing React a new object on every selector call.
  const earnedBreakMs = useTimerStore((s) => s.state.earnedBreakMs)
  const settings = useTimerStore((s) => s.settings)

  if (!show) return null

  const earned = earnedBreakMs ?? 0
  const min = Math.max(0, settings.flowmodoroMinBreakMs)
  const cap = Math.max(min, settings.flowmodoroMaxBreakMs)
  const fraction = Math.min(1, earned / Math.max(1, cap))

  const hint =
    earned >= cap
      ? 'maximum reached'
      : earned <= min
        ? `minimum ${durationLabel(min)}`
        : `up to ${durationLabel(cap)}`

  return (
    <div
      // `w-full max-w-[320px]` rather than a fixed `w-[320px]`: at the timer panel's own
      // minimum width this card is wider than the panel, which used to force the whole
      // panel to scroll horizontally (v0.4's known bug) — `w-full` lets it shrink with its
      // (centred, `items-center`) parent instead, while the max keeps its usual 320px size
      // everywhere the panel has room for it.
      className="w-full max-w-[320px] rounded-2xl border px-4 pt-2 pb-2.5"
      style={{
        borderColor: 'color-mix(in srgb, var(--color-break) 26%, transparent)',
        background: 'color-mix(in srgb, var(--color-break) 7%, transparent)'
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
          Break earned
        </span>
        <span className="text-[10px] tabular text-[var(--color-text-muted)]">
          1 : {settings.flowmodoroDivisor}
        </span>
      </div>

      <div className="mt-0.5 flex items-end justify-between gap-3">
        <span
          className="tabular text-[30px] font-light leading-none tracking-tight"
          style={{ color: 'var(--color-break)' }}
        >
          {formatClock(earned)}
        </span>
        <span className="pb-0.5 text-[11px] text-[var(--color-text-muted)]">{hint}</span>
      </div>

      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${fraction * 100}%`,
            background: 'var(--color-break)',
            // Matches main's 250ms tick so the bar glides instead of stepping.
            transition: 'width 250ms linear'
          }}
        />
      </div>
    </div>
  )
}
