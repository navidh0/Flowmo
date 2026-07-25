/**
 * What the dial and the mini widget's bar are supposed to show.
 *
 * Shared rather than duplicated because the two surfaces must agree about which direction the
 * digits move and what a full ring means — the panel and the widget are visible at the same
 * time, and disagreeing about it would look like a bug in one of them.
 *
 * Nothing here reads a clock. Every number arrives pre-derived in the `TimerState` broadcast
 * by main; this only picks which of them to paint.
 */

import { initialPlannedMs } from '@shared/timer-math'
import type { Settings, TimerState } from '@shared/types'
import { formatClock, formatDuration } from '../../lib/format'
import { isActive, isArmed, isOpenEnded } from '../../stores/timer'

export interface Readout {
  /** Pre-formatted, already counting the direction this phase counts. */
  time: string
  /** 0..1 of the ring or bar to paint. */
  fraction: number
  /** No fixed target: the track is drawn as ticks rather than a solid line. */
  openEnded: boolean
  /** Not running. Dims the arc so armed and paused never read as live. */
  muted: boolean
}

/**
 * A duration written for a label rather than a countdown.
 *
 * `formatDuration` floors to whole minutes, which renders anything under a minute as a bare
 * "0m" — and sub-minute durations are real here: a Flowmodoro break earned in the first minutes
 * of a session, or a deliberately short test setting.
 */
export function durationLabel(ms: number): string {
  return ms >= 60_000 ? formatDuration(ms) : formatClock(ms)
}

export function readout(s: TimerState, settings: Settings): Readout {
  const muted = s.status !== 'running'

  // Flowmodoro focus has no plan, so it counts UP and the ring fills with the break it has
  // earned, against the configured cap. Leaving it pinned at 0% for an hour would look broken,
  // and the earned break is monotonic in elapsed time so the arc still only ever grows.
  if (isOpenEnded(s) && isActive(s)) {
    const cap = Math.max(1, settings.flowmodoroMaxBreakMs)
    return {
      time: formatClock(s.elapsedMs),
      fraction: (s.earnedBreakMs ?? 0) / cap,
      openEnded: true,
      muted
    }
  }

  // Bounded phase: count down and drain the ring.
  if (isActive(s)) {
    return {
      time: formatClock(s.remainingMs ?? 0),
      fraction: 1 - s.progress,
      openEnded: false,
      muted
    }
  }

  // Idle. An armed phase shows the full duration it is about to start with; a fresh timer
  // shows what the next focus would be, so the dial is never blank on launch. Both paint a
  // full-but-dimmed ring, which reads as charged and waiting rather than finished.
  const planned = isArmed(s) ? s.plannedMs : initialPlannedMs(s.mode, 'focus', settings)
  return {
    time: formatClock(planned ?? 0),
    fraction: planned == null ? 0 : 1,
    openEnded: planned == null,
    muted: true
  }
}
