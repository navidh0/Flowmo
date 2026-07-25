/**
 * Where you are in the Pomodoro long-break cycle. Renders nothing in Flowmodoro, which has no
 * long breaks — its break already scales with the focus that earned it.
 *
 * `focusRoundsCompleted` resets to 0 *after* a long break, so a full cycle reads as
 * `rounds === every` for the duration of that break rather than wrapping straight back to 0 —
 * hence the modulo only being applied once the counter has actually wrapped.
 */

import { ACCENT_BREAK, ACCENT_FOCUS, isActive, longBreakNext, useTimerStore } from '../../stores/timer'
import { CoffeeIcon } from './icons'

export function RoundDots(): React.JSX.Element | null {
  const pomodoro = useTimerStore((s) => s.state.mode === 'pomodoro')
  const every = useTimerStore((s) => (s.state.longBreakEvery > 0 ? s.state.longBreakEvery : 4))
  const rounds = useTimerStore((s) => s.state.focusRoundsCompleted)
  const inFocus = useTimerStore((s) => s.state.kind === 'focus' && isActive(s.state))
  const longNext = useTimerStore((s) => longBreakNext(s.state))

  if (!pomodoro) return null

  const wrapped = rounds % every
  const done = wrapped === 0 && rounds > 0 ? every : wrapped
  const currentIndex = inFocus && done < every ? done : -1

  return (
    <div
      className="flex items-center gap-2.5"
      title={`${done} of ${every} focus rounds this cycle`}
    >
      <div className="flex items-center gap-1.5" role="img" aria-label={`Round ${Math.min(done + 1, every)} of ${every}`}>
        {Array.from({ length: every }, (_, i) => {
          const filled = i < done
          const current = i === currentIndex
          return (
            <span
              key={i}
              className="block h-[7px] w-[7px] rounded-full transition-[background-color,box-shadow] duration-200"
              style={{
                background: filled ? ACCENT_FOCUS : 'var(--color-border)',
                boxShadow: current ? `0 0 0 1.5px ${ACCENT_FOCUS}` : undefined
              }}
            />
          )
        })}
      </div>

      {longNext && (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium"
          style={{ color: ACCENT_BREAK }}
        >
          <CoffeeIcon className="h-3 w-3" />
          Long break next
        </span>
      )}
    </div>
  )
}
