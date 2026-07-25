/**
 * Independent check on src/shared/timer-math.ts.
 *
 * Every case pins to the worked examples in that file's JSDoc, plus the abuse cases a
 * user-editable settings screen makes reachable (divisor 0, max below min, longBreakEvery 0)
 * and the clock hazards the anchor design exists to survive (backwards steps, sleep, a
 * multi-hour jump). Pure functions, so `now` is always passed explicitly — no fake timers.
 */

import { describe, expect, it } from 'vitest'
import {
  applySleepGap,
  clamp,
  computeEarnedBreakMs,
  elapsedMsOf,
  initialPlannedMs,
  isExpired,
  nextPhase,
  progressOf,
  remainingMsOf,
  shouldAutoStart,
  type PhaseSettings
} from '@shared/timer-math'
import { DEFAULT_SETTINGS, type Settings, type TimerAnchor } from '@shared/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A realistic epoch so nothing accidentally passes because startedAt is 0. */
const T0 = 1_700_000_000_000

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

function anchorOf(patch: Partial<TimerAnchor> = {}): TimerAnchor {
  return { startedAt: T0, pausedAt: null, pausedTotalMs: 0, ...patch }
}

describe('clamp', () => {
  it('bounds a value to the range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(50, 0, 10)).toBe(10)
  })

  it('returns min for NaN rather than propagating it', () => {
    expect(clamp(Number.NaN, 3, 10)).toBe(3)
  })
})

describe('computeEarnedBreakMs', () => {
  const flow = settings()

  it('matches the documented worked examples', () => {
    expect(computeEarnedBreakMs(50 * MINUTE, flow)).toBe(10 * MINUTE)
    expect(computeEarnedBreakMs(25 * MINUTE, flow)).toBe(5 * MINUTE)
  })

  it('clamps up to flowmodoroMinBreakMs for a tiny focus', () => {
    // 10 s / 5 = 2 s, which is not a break anybody can use.
    expect(computeEarnedBreakMs(10_000, flow)).toBe(flow.flowmodoroMinBreakMs)
    expect(computeEarnedBreakMs(10_000, flow)).toBe(1 * MINUTE)
  })

  it('clamps down to flowmodoroMaxBreakMs for a huge focus', () => {
    // 4 h / 5 = 48 min, capped at 30.
    expect(computeEarnedBreakMs(4 * HOUR, flow)).toBe(flow.flowmodoroMaxBreakMs)
    expect(computeEarnedBreakMs(4 * HOUR, flow)).toBe(30 * MINUTE)
  })

  it('earns nothing from zero or negative focus, with no min clamp applied', () => {
    expect(computeEarnedBreakMs(0, flow)).toBe(0)
    expect(computeEarnedBreakMs(-1, flow)).toBe(0)
    expect(computeEarnedBreakMs(-10 * MINUTE, flow)).toBe(0)
  })

  it('survives non-finite focus input', () => {
    expect(computeEarnedBreakMs(Number.NaN, flow)).toBe(0)
    expect(computeEarnedBreakMs(Number.POSITIVE_INFINITY, flow)).toBe(0)
  })

  it('coerces a divisor of 0 or negative to 1 instead of producing Infinity/NaN', () => {
    const zero = computeEarnedBreakMs(10 * MINUTE, settings({ flowmodoroDivisor: 0 }))
    expect(Number.isFinite(zero)).toBe(true)
    expect(zero).toBe(10 * MINUTE)

    const negative = computeEarnedBreakMs(10 * MINUTE, settings({ flowmodoroDivisor: -5 }))
    expect(Number.isFinite(negative)).toBe(true)
    expect(negative).toBe(10 * MINUTE)
  })

  it('does not invert the clamp when max is lower than min', () => {
    const inverted = settings({ flowmodoroMinBreakMs: 5 * MINUTE, flowmodoroMaxBreakMs: MINUTE })
    // min wins; the result must land inside [min, min], never below min.
    expect(computeEarnedBreakMs(50 * MINUTE, inverted)).toBe(5 * MINUTE)
    expect(computeEarnedBreakMs(10_000, inverted)).toBe(5 * MINUTE)
  })

  it('treats a negative min as 0', () => {
    const negMin = settings({ flowmodoroMinBreakMs: -10 * MINUTE })
    expect(computeEarnedBreakMs(50 * MINUTE, negMin)).toBe(10 * MINUTE)
  })

  it('returns whole milliseconds', () => {
    const earned = computeEarnedBreakMs(1001, settings({ flowmodoroMinBreakMs: 0 }))
    expect(Number.isInteger(earned)).toBe(true)
  })
})

describe('elapsedMsOf', () => {
  it('tracks `now` while running', () => {
    expect(elapsedMsOf(anchorOf(), T0)).toBe(0)
    expect(elapsedMsOf(anchorOf(), T0 + 90_000)).toBe(90_000)
  })

  it('freezes at pausedAt, so repeated calls with an advancing `now` are identical', () => {
    const paused = anchorOf({ pausedAt: T0 + 10 * MINUTE })

    const first = elapsedMsOf(paused, T0 + 10 * MINUTE)
    const second = elapsedMsOf(paused, T0 + 30 * MINUTE)
    const third = elapsedMsOf(paused, T0 + 3 * HOUR)

    expect(first).toBe(10 * MINUTE)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('subtracts pausedTotalMs across multiple pause cycles', () => {
    // Paused twice, 2 min then 3 min, over a 30 min wall-clock span.
    const anchor = anchorOf({ pausedTotalMs: 5 * MINUTE })
    expect(elapsedMsOf(anchor, T0 + 30 * MINUTE)).toBe(25 * MINUTE)
  })

  it('subtracts both a completed pause total and the freeze of an in-progress pause', () => {
    const anchor = anchorOf({ pausedTotalMs: 2 * MINUTE, pausedAt: T0 + 20 * MINUTE })
    expect(elapsedMsOf(anchor, T0 + 45 * MINUTE)).toBe(18 * MINUTE)
  })

  it('never goes negative when the clock steps backwards', () => {
    expect(elapsedMsOf(anchorOf(), T0 - 10 * MINUTE)).toBe(0)
    expect(elapsedMsOf(anchorOf({ pausedTotalMs: HOUR }), T0 + MINUTE)).toBe(0)
  })
})

describe('remainingMsOf', () => {
  it('counts down a bounded phase', () => {
    expect(remainingMsOf(25 * MINUTE, 0)).toBe(25 * MINUTE)
    expect(remainingMsOf(25 * MINUTE, 10 * MINUTE)).toBe(15 * MINUTE)
  })

  it('floors at 0 when overshooting', () => {
    expect(remainingMsOf(25 * MINUTE, 40 * MINUTE)).toBe(0)
  })

  it('is null for an open-ended phase', () => {
    expect(remainingMsOf(null, 0)).toBeNull()
    expect(remainingMsOf(null, 3 * HOUR)).toBeNull()
  })
})

describe('progressOf', () => {
  it('is a 0..1 fraction of plannedMs', () => {
    expect(progressOf(25 * MINUTE, 0)).toBe(0)
    expect(progressOf(20 * MINUTE, 5 * MINUTE)).toBeCloseTo(0.25, 10)
    expect(progressOf(20 * MINUTE, 20 * MINUTE)).toBe(1)
  })

  it('does not exceed 1 when overshooting', () => {
    expect(progressOf(20 * MINUTE, 3 * HOUR)).toBe(1)
  })

  it('does not go below 0', () => {
    expect(progressOf(20 * MINUTE, -5 * MINUTE)).toBe(0)
  })

  it('is 0 for an open-ended or zero-length phase', () => {
    expect(progressOf(null, 3 * HOUR)).toBe(0)
    expect(progressOf(0, 3 * HOUR)).toBe(0)
    expect(progressOf(-1, 3 * HOUR)).toBe(0)
  })
})

describe('isExpired', () => {
  it('expires a bounded phase at or past plannedMs', () => {
    expect(isExpired(25 * MINUTE, 25 * MINUTE - 1)).toBe(false)
    expect(isExpired(25 * MINUTE, 25 * MINUTE)).toBe(true)
    expect(isExpired(25 * MINUTE, 25 * MINUTE + 1)).toBe(true)
  })

  it('never expires an open-ended phase, even hours in', () => {
    expect(isExpired(null, 0)).toBe(false)
    expect(isExpired(null, 8 * HOUR)).toBe(false)
  })
})

describe('initialPlannedMs', () => {
  const phase: PhaseSettings = settings()

  it('gives Pomodoro focus a plan and Flowmodoro focus none', () => {
    expect(initialPlannedMs('pomodoro', 'focus', phase)).toBe(25 * MINUTE)
    expect(initialPlannedMs('flowmodoro', 'focus', phase)).toBeNull()
  })

  it('uses the configured break durations in both modes', () => {
    expect(initialPlannedMs('pomodoro', 'short_break', phase)).toBe(5 * MINUTE)
    expect(initialPlannedMs('pomodoro', 'long_break', phase)).toBe(15 * MINUTE)
    expect(initialPlannedMs('flowmodoro', 'short_break', phase)).toBe(5 * MINUTE)
  })
})

describe('nextPhase — Pomodoro sequencing', () => {
  const base = settings({ longBreakEvery: 4 })

  function afterFocus(focusRoundsCompleted: number, patch: Partial<Settings> = {}) {
    return nextPhase({
      mode: 'pomodoro',
      endedKind: 'focus',
      focusRoundsCompleted,
      focusElapsedMs: 25 * MINUTE,
      settings: { ...base, ...patch }
    })
  }

  it('sends rounds 0, 1 and 2 to a short break and increments the counter', () => {
    expect(afterFocus(0)).toEqual({
      kind: 'short_break',
      plannedMs: 5 * MINUTE,
      focusRoundsCompleted: 1
    })
    expect(afterFocus(1)).toEqual({
      kind: 'short_break',
      plannedMs: 5 * MINUTE,
      focusRoundsCompleted: 2
    })
    expect(afterFocus(2)).toEqual({
      kind: 'short_break',
      plannedMs: 5 * MINUTE,
      focusRoundsCompleted: 3
    })
  })

  it('sends round 3 to a long break with focusRoundsCompleted 4', () => {
    expect(afterFocus(3)).toEqual({
      kind: 'long_break',
      plannedMs: 15 * MINUTE,
      focusRoundsCompleted: 4
    })
  })

  it('resets the cycle to 0 after a long break', () => {
    expect(
      nextPhase({
        mode: 'pomodoro',
        endedKind: 'long_break',
        focusRoundsCompleted: 4,
        focusElapsedMs: 0,
        settings: base
      })
    ).toEqual({ kind: 'focus', plannedMs: 25 * MINUTE, focusRoundsCompleted: 0 })
  })

  it('leaves the cycle counter untouched after a short break', () => {
    expect(
      nextPhase({
        mode: 'pomodoro',
        endedKind: 'short_break',
        focusRoundsCompleted: 2,
        focusElapsedMs: 0,
        settings: base
      })
    ).toEqual({ kind: 'focus', plannedMs: 25 * MINUTE, focusRoundsCompleted: 2 })
  })

  it('makes every break long when longBreakEvery is 1', () => {
    for (const rounds of [0, 1, 2, 7]) {
      const next = afterFocus(rounds, { longBreakEvery: 1 })
      expect(next.kind).toBe('long_break')
      expect(next.plannedMs).toBe(15 * MINUTE)
      expect(next.focusRoundsCompleted).toBe(rounds + 1)
    }
  })

  it('falls back to 4 for a nonsense longBreakEvery of 0 (no divide by zero)', () => {
    for (const rounds of [0, 1, 2]) {
      const next = afterFocus(rounds, { longBreakEvery: 0 })
      expect(next.kind).toBe('short_break')
      expect(Number.isFinite(next.plannedMs ?? 0)).toBe(true)
    }
    expect(afterFocus(3, { longBreakEvery: 0 }).kind).toBe('long_break')
  })

  it('falls back to 4 for a negative longBreakEvery', () => {
    expect(afterFocus(0, { longBreakEvery: -4 }).kind).toBe('short_break')
    expect(afterFocus(3, { longBreakEvery: -4 }).kind).toBe('long_break')
  })

  it('ignores focusElapsedMs — Pomodoro breaks are fixed', () => {
    const short = nextPhase({
      mode: 'pomodoro',
      endedKind: 'focus',
      focusRoundsCompleted: 0,
      focusElapsedMs: 3 * HOUR,
      settings: base
    })
    expect(short.plannedMs).toBe(5 * MINUTE)
  })
})

describe('nextPhase — Flowmodoro sequencing', () => {
  const base = settings({ mode: 'flowmodoro' })

  it('turns focus into a short break of exactly the earned duration', () => {
    const next = nextPhase({
      mode: 'flowmodoro',
      endedKind: 'focus',
      focusRoundsCompleted: 0,
      focusElapsedMs: 50 * MINUTE,
      settings: base
    })
    expect(next).toEqual({
      kind: 'short_break',
      plannedMs: computeEarnedBreakMs(50 * MINUTE, base),
      focusRoundsCompleted: 1
    })
    expect(next.plannedMs).toBe(10 * MINUTE)
  })

  it('returns from a break to an open-ended focus, cycle counter unchanged', () => {
    expect(
      nextPhase({
        mode: 'flowmodoro',
        endedKind: 'short_break',
        focusRoundsCompleted: 3,
        focusElapsedMs: 0,
        settings: base
      })
    ).toEqual({ kind: 'focus', plannedMs: null, focusRoundsCompleted: 3 })
  })

  it('never emits a long break, whatever the focus length or cycle position', () => {
    for (const rounds of [0, 1, 2, 3, 4, 8, 15]) {
      for (const focusMs of [1, MINUTE, 25 * MINUTE, 4 * HOUR]) {
        const next = nextPhase({
          mode: 'flowmodoro',
          endedKind: 'focus',
          focusRoundsCompleted: rounds,
          focusElapsedMs: focusMs,
          settings: base
        })
        expect(next.kind).toBe('short_break')
      }
    }
  })

  it('respects the min/max clamp when sequencing', () => {
    const tiny = nextPhase({
      mode: 'flowmodoro',
      endedKind: 'focus',
      focusRoundsCompleted: 0,
      focusElapsedMs: 10_000,
      settings: base
    })
    expect(tiny.plannedMs).toBe(MINUTE)

    const huge = nextPhase({
      mode: 'flowmodoro',
      endedKind: 'focus',
      focusRoundsCompleted: 0,
      focusElapsedMs: 4 * HOUR,
      settings: base
    })
    expect(huge.plannedMs).toBe(30 * MINUTE)
  })
})

describe('shouldAutoStart', () => {
  it('reads autoStartFocus for focus', () => {
    expect(shouldAutoStart('focus', { autoStartFocus: true, autoStartBreaks: false })).toBe(true)
    expect(shouldAutoStart('focus', { autoStartFocus: false, autoStartBreaks: true })).toBe(false)
  })

  it('reads autoStartBreaks for both break kinds', () => {
    const on = { autoStartFocus: false, autoStartBreaks: true }
    const off = { autoStartFocus: true, autoStartBreaks: false }
    expect(shouldAutoStart('short_break', on)).toBe(true)
    expect(shouldAutoStart('long_break', on)).toBe(true)
    expect(shouldAutoStart('short_break', off)).toBe(false)
    expect(shouldAutoStart('long_break', off)).toBe(false)
  })

  it('matches the defaults: breaks auto-start, focus does not', () => {
    expect(shouldAutoStart('short_break', DEFAULT_SETTINGS)).toBe(true)
    expect(shouldAutoStart('focus', DEFAULT_SETTINGS)).toBe(false)
  })
})

describe('applySleepGap', () => {
  const grace = 2 * MINUTE

  it('treats a gap within grace as continuous work', () => {
    expect(applySleepGap(25 * MINUTE, 30_000, grace)).toEqual({
      elapsedMs: 25 * MINUTE,
      interrupted: false
    })
  })

  it('treats a gap exactly at grace as continuous work', () => {
    expect(applySleepGap(25 * MINUTE, grace, grace)).toEqual({
      elapsedMs: 25 * MINUTE,
      interrupted: false
    })
  })

  it('subtracts a gap beyond grace and flags the session', () => {
    expect(applySleepGap(3 * HOUR + 10 * MINUTE, 3 * HOUR, grace)).toEqual({
      elapsedMs: 10 * MINUTE,
      interrupted: true
    })
  })

  it('never yields negative elapsed when the gap swallows the phase', () => {
    const adjusted = applySleepGap(MINUTE, 8 * HOUR, grace)
    expect(adjusted.elapsedMs).toBe(0)
    expect(adjusted.interrupted).toBe(true)
  })

  it('flags any gap when grace is 0', () => {
    expect(applySleepGap(MINUTE, 1, 0)).toEqual({ elapsedMs: MINUTE - 1, interrupted: true })
    expect(applySleepGap(MINUTE, 0, 0)).toEqual({ elapsedMs: MINUTE, interrupted: false })
  })
})

describe('multi-hour clock jump', () => {
  it('reports wall-clock elapsed for a phase the process slept through', () => {
    // The whole point of the anchor design: no ticks ran for three hours, and the
    // arithmetic still agrees with the wall clock.
    const anchor = anchorOf()
    expect(elapsedMsOf(anchor, T0 + 3 * HOUR)).toBe(3 * HOUR)
  })

  it('reconstructs a full paused-then-jumped Flowmodoro session from anchors alone', () => {
    // Started at T0, paused T0+30min, resumed T0+40min (10 min banked), then the machine
    // went away and `now` came back three hours after the start.
    const anchor = anchorOf({ pausedAt: null, pausedTotalMs: 10 * MINUTE })
    const now = T0 + 3 * HOUR

    const elapsed = elapsedMsOf(anchor, now)
    expect(elapsed).toBe(3 * HOUR - 10 * MINUTE) // 170 min

    // Open-ended focus: nothing to count down, nothing to expire.
    expect(remainingMsOf(null, elapsed)).toBeNull()
    expect(progressOf(null, elapsed)).toBe(0)
    expect(isExpired(null, elapsed)).toBe(false)

    // 170 min / 5 = 34 min, capped at the 30 min max.
    expect(computeEarnedBreakMs(elapsed, settings())).toBe(30 * MINUTE)

    // With the gap accounted for, only the pre-sleep work survives.
    const adjusted = applySleepGap(elapsed, 2 * HOUR + 20 * MINUTE, DEFAULT_SETTINGS.sleepGraceMs)
    expect(adjusted).toEqual({ elapsedMs: 30 * MINUTE, interrupted: true })
    expect(computeEarnedBreakMs(adjusted.elapsedMs, settings())).toBe(6 * MINUTE)
  })

  it('a bounded Pomodoro phase slept through is simply over, not overshot', () => {
    const anchor = anchorOf()
    const elapsed = elapsedMsOf(anchor, T0 + 3 * HOUR)

    expect(isExpired(25 * MINUTE, elapsed)).toBe(true)
    expect(remainingMsOf(25 * MINUTE, elapsed)).toBe(0)
    expect(progressOf(25 * MINUTE, elapsed)).toBe(1)
  })
})
