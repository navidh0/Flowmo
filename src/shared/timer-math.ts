/**
 * Pure timer arithmetic — no Electron imports, no I/O, no reads of the ambient clock
 * except where `now` is passed in explicitly.
 *
 * Everything tricky about this app lives here: break computation, phase sequencing,
 * pause accounting, and sleep compensation. Keeping it pure is what makes it testable
 * under plain Vitest without booting Electron, which is why `main/timer.ts` should hold
 * only state transitions and delegate every calculation to this file.
 */

import type { Settings, SessionKind, TimerAnchor, TimerMode } from './types'

/** Settings subset the Flowmodoro break formula needs. */
export type FlowmodoroSettings = Pick<
  Settings,
  'flowmodoroDivisor' | 'flowmodoroMinBreakMs' | 'flowmodoroMaxBreakMs'
>

/** Settings subset phase sequencing needs. */
export type PhaseSettings = Pick<
  Settings,
  | 'pomodoroFocusMs'
  | 'pomodoroShortBreakMs'
  | 'pomodoroLongBreakMs'
  | 'longBreakEvery'
  | 'flowmodoroDivisor'
  | 'flowmodoroMinBreakMs'
  | 'flowmodoroMaxBreakMs'
>

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * The Flowmodoro rule: `break = clamp(focus / divisor, min, max)`.
 *
 * Worked examples with the defaults (divisor 5, min 1 min, max 30 min):
 *   50 min focus  → 10 min break
 *   25 min focus  →  5 min break
 *   10 s   focus  →  1 min break  (clamped up to min)
 *    4 h   focus  → 30 min break  (clamped down to max)
 *    0     focus  →  0            (nothing earned, no clamp applied)
 *
 * `divisor` is user-editable, so a zero or negative value is coerced to 1 rather than
 * producing Infinity and a break that never ends.
 */
export function computeEarnedBreakMs(
  focusElapsedMs: number,
  settings: FlowmodoroSettings
): number {
  if (!Number.isFinite(focusElapsedMs) || focusElapsedMs <= 0) return 0

  const divisor = settings.flowmodoroDivisor > 0 ? settings.flowmodoroDivisor : 1
  const min = Math.max(0, settings.flowmodoroMinBreakMs)
  const max = Math.max(min, settings.flowmodoroMaxBreakMs)

  return Math.round(clamp(focusElapsedMs / divisor, min, max))
}

/**
 * Elapsed time for a phase, derived from wall-clock anchors.
 *
 * This is the function that makes the app survive being minimised and the laptop
 * sleeping: it never accumulates ticks, it subtracts. While paused, elapsed is frozen
 * at `pausedAt` so the number on screen stops moving.
 */
export function elapsedMsOf(anchor: TimerAnchor, now: number): number {
  const end = anchor.pausedAt ?? now
  return Math.max(0, end - anchor.startedAt - anchor.pausedTotalMs)
}

/** Remaining time, or null for an open-ended phase (Flowmodoro focus). */
export function remainingMsOf(plannedMs: number | null, elapsedMs: number): number | null {
  if (plannedMs == null) return null
  return Math.max(0, plannedMs - elapsedMs)
}

/** 0..1 against `plannedMs`. Always 0 when open-ended — there is nothing to be a fraction of. */
export function progressOf(plannedMs: number | null, elapsedMs: number): number {
  if (plannedMs == null || plannedMs <= 0) return 0
  return clamp(elapsedMs / plannedMs, 0, 1)
}

/** True once a bounded phase has run its course. Open-ended phases never expire. */
export function isExpired(plannedMs: number | null, elapsedMs: number): boolean {
  if (plannedMs == null) return false
  return elapsedMs >= plannedMs
}

/** The duration a phase starts with. Flowmodoro focus is open-ended, hence null. */
export function initialPlannedMs(
  mode: TimerMode,
  kind: SessionKind,
  settings: PhaseSettings
): number | null {
  if (kind === 'focus') {
    return mode === 'pomodoro' ? settings.pomodoroFocusMs : null
  }
  if (kind === 'long_break') return settings.pomodoroLongBreakMs
  return settings.pomodoroShortBreakMs
}

export interface NextPhaseInput {
  mode: TimerMode
  /** The phase that just ended. */
  endedKind: SessionKind
  /** Focus rounds completed in the cycle *before* this phase ended. */
  focusRoundsCompleted: number
  /** Elapsed focus time, used only when `endedKind` is 'focus' in Flowmodoro. */
  focusElapsedMs: number
  settings: PhaseSettings
}

export interface NextPhase {
  kind: SessionKind
  plannedMs: number | null
  /** Updated cycle counter — resets to 0 after a long break. */
  focusRoundsCompleted: number
}

/**
 * Phase sequencing for both modes.
 *
 * Pomodoro, with longBreakEvery = 4:
 *   focus(round 0) → short_break, rounds=1
 *   focus(round 1) → short_break, rounds=2
 *   focus(round 2) → short_break, rounds=3
 *   focus(round 3) → LONG break,  rounds=4     ← every 4th focus
 *   long_break     → focus,       rounds=0     ← cycle resets
 *   short_break    → focus,       rounds unchanged
 *
 * Flowmodoro (no long breaks — the break already scales with the focus):
 *   focus       → short_break with the earned duration, rounds+1
 *   short_break → focus, open-ended, rounds unchanged
 */
export function nextPhase(input: NextPhaseInput): NextPhase {
  const { mode, endedKind, focusRoundsCompleted, focusElapsedMs, settings } = input

  if (endedKind === 'focus') {
    const rounds = focusRoundsCompleted + 1

    if (mode === 'flowmodoro') {
      return {
        kind: 'short_break',
        plannedMs: computeEarnedBreakMs(focusElapsedMs, settings),
        focusRoundsCompleted: rounds
      }
    }

    const every = settings.longBreakEvery > 0 ? settings.longBreakEvery : 4
    const isLong = rounds % every === 0

    return {
      kind: isLong ? 'long_break' : 'short_break',
      plannedMs: isLong ? settings.pomodoroLongBreakMs : settings.pomodoroShortBreakMs,
      focusRoundsCompleted: rounds
    }
  }

  // A break ended → back to focus.
  return {
    kind: 'focus',
    plannedMs: initialPlannedMs(mode, 'focus', settings),
    focusRoundsCompleted: endedKind === 'long_break' ? 0 : focusRoundsCompleted
  }
}

/** Whether main should auto-start the phase that `nextPhase` just computed. */
export function shouldAutoStart(
  nextKind: SessionKind,
  settings: Pick<Settings, 'autoStartBreaks' | 'autoStartFocus'>
): boolean {
  return nextKind === 'focus' ? settings.autoStartFocus : settings.autoStartBreaks
}

export interface SleepAdjustment {
  elapsedMs: number
  interrupted: boolean
}

/**
 * Compensate for a suspend/resume gap.
 *
 * Sleeping for an hour is not an hour of focus. A gap within the grace window is
 * treated as continuous work (you stepped away briefly); anything longer is subtracted
 * and the session is flagged so the stats can show it was not a clean run.
 */
export function applySleepGap(
  elapsedMs: number,
  gapMs: number,
  sleepGraceMs: number
): SleepAdjustment {
  if (gapMs <= sleepGraceMs) {
    return { elapsedMs, interrupted: false }
  }
  return { elapsedMs: Math.max(0, elapsedMs - gapMs), interrupted: true }
}
