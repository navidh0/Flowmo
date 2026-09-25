/**
 * Pomodoro ⇄ Flowmodoro, always visible.
 *
 * Switching mid-session destroys the session, so it asks first. The confirm is an inline
 * popover rather than `window.confirm` — a native modal in Electron freezes the whole
 * renderer, drops the tick animation, and looks like the app hung.
 */

import { useEffect, useRef, useState } from 'react'
import type { TimerMode } from '@shared/types'
import {
  MODE_LABEL,
  isActive,
  phaseName,
  timerActions,
  useTimerStore
} from '../../stores/timer'
import { Button } from './Button'

const MODES: readonly TimerMode[] = ['pomodoro', 'flowmodoro']

export function ModeToggle(): React.JSX.Element {
  const mode = useTimerStore((s) => s.state.mode)
  // Selecting the two fields the decision needs, not the whole state, keeps this component
  // out of the four-times-a-second render path.
  const active = useTimerStore((s) => isActive(s.state))
  const runningPhase = useTimerStore((s) => (isActive(s.state) ? phaseName(s.state) : null))

  const [pending, setPending] = useState<TimerMode | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (pending == null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPending(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending])

  // An armed phase has nothing logged and nothing accruing, so switching costs nothing —
  // only a live or paused session needs the question.
  function request(next: TimerMode): void {
    if (next === mode) return
    if (active) setPending(next)
    else timerActions.setMode(next)
  }

  function resolve(choice: 'keep' | 'discard'): void {
    if (pending == null) return
    timerActions.setMode(pending, choice)
    setPending(null)
  }

  const activeIndex = mode === 'flowmodoro' ? 1 : 0

  return (
    // `flex w-full justify-center`, not a bare `relative`: the pill itself stays exactly as
    // wide as its content (still centred, `justify-center` does that job `items-center` on
    // the parent column used to), but this box now spans the whole panel width — which is
    // what lets the confirm popover below size itself against the PANEL's width instead of
    // the narrower pill's, so it can shrink to fit at the panel's minimum instead of
    // overflowing it (v0.4's known bug).
    <div className="relative flex w-full justify-center" ref={rootRef}>
      <div
        role="radiogroup"
        aria-label="Timer mode"
        className="relative flex rounded-full border border-[var(--color-border)] bg-[var(--color-surface-sunken)] p-1"
      >
        <div
          aria-hidden="true"
          className="absolute top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-full bg-[var(--color-surface-raised)] shadow-sm transition-transform duration-200 ease-out"
          style={{ transform: `translateX(${activeIndex * 100}%)`, left: '0.25rem' }}
        />
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={m === mode}
            onClick={() => request(m)}
            className={`relative z-10 h-8 w-[112px] rounded-full text-[12px] font-medium transition-colors duration-150 ${
              m === mode
                ? 'text-[var(--color-text)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {pending && (
        <>
          {/* Catches the click that dismisses the popover without stealing focus styling. */}
          <div className="fixed inset-0 z-20" onClick={() => setPending(null)} />
          <div className="absolute top-[calc(100%+8px)] left-1/2 z-30 w-full max-w-[292px] -translate-x-1/2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-3 shadow-2xl shadow-black/50">
            <p className="text-[12px] leading-relaxed text-[var(--color-text)]">
              {runningPhase ?? 'A session'} is in progress. Switching to{' '}
              <span className="font-medium">{MODE_LABEL[pending]}</span> ends it.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => resolve('keep')}>
                Keep &amp; log
              </Button>
              <Button size="sm" variant="danger" onClick={() => resolve('discard')}>
                Discard
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setPending(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
