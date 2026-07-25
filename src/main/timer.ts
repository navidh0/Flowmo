/**
 * The authoritative timer.
 *
 * It lives in main because Chromium throttles `setInterval` in background renderers, so a
 * renderer-owned timer silently drifts by minutes while the window is hidden — exactly when
 * a focus timer matters most.
 *
 * The invariant this file exists to protect: **ticks are never accumulated**. State is a
 * `TimerAnchor` plus a phase descriptor, and every number the UI shows is derived from that
 * anchor through `@shared/timer-math` on demand. The interval only triggers a recompute and
 * a broadcast; if it fires late, twice, or not at all, the numbers are still right.
 *
 * Dependencies are injected rather than imported so this file stays Electron-free and
 * testable, and so the db and window modules can be wired in by the integration layer.
 */

import { EV } from '@shared/channels'
import {
  applySleepGap,
  computeEarnedBreakMs,
  elapsedMsOf,
  initialPlannedMs,
  isExpired,
  nextPhase,
  progressOf,
  remainingMsOf,
  shouldAutoStart
} from '@shared/timer-math'
import type {
  OnRunningSession,
  PhaseEndEvent,
  SessionCreate,
  SessionKind,
  Settings,
  TimerAnchor,
  TimerMode,
  TimerState,
  TimerStatus
} from '@shared/types'

/** Fast enough that the seconds digit never visibly stalls, cheap enough to ignore. */
const TICK_MS = 250

/** Shorter than this is a mis-click, not a session. Logging it just pollutes the stats. */
const MIN_LOGGED_MS = 1000

export interface TimerDeps {
  getSettings(): Settings
  createSession(input: SessionCreate): { id: number }
  broadcast(channel: string, payload: unknown): void
  getProjectIdForTask(taskId: number | null): number | null
  /** Defaults to Date.now; injected in tests so the clock can be stepped explicitly. */
  now?(): number
}

export interface TimerService {
  getState(): TimerState
  /** Starts the armed phase (or focus) when idle; resumes when paused. */
  start(taskId?: number | null): TimerState
  pause(): TimerState
  resume(): TimerState
  /** Flowmodoro: end the open-ended focus and begin the break it earned. Pomodoro: skip. */
  takeBreak(): TimerState
  skip(): TimerState
  stop(discard?: boolean): TimerState
  setMode(mode: TimerMode, onRunning?: OnRunningSession): TimerState
  setTask(taskId: number | null): TimerState

  /**
   * Recompute, end the phase if it expired, broadcast. The interval calls this; exposed so
   * tests (and a future manual "refresh") can drive the machine without real timers.
   */
  tick(): TimerState

  /** Power hooks for src/main/power.ts. Sleeping three hours is not three hours of focus. */
  handleSuspend(): void
  handleResume(): TimerState

  /** Clear the interval. Call on app quit. */
  dispose(): void
}

const IDLE_ANCHOR: TimerAnchor = { startedAt: 0, pausedAt: null, pausedTotalMs: 0 }

export function createTimerService(deps: TimerDeps): TimerService {
  const clock = (): number => (deps.now ? deps.now() : Date.now())

  /**
   * `mode` is mirrored from settings at construction and thereafter only changed through
   * `setMode`. The integration layer must route mode changes here rather than writing the
   * setting directly, or the two disagree.
   */
  let mode: TimerMode = deps.getSettings().mode

  let status: TimerStatus = 'idle'

  /**
   * Non-null while idle means **idle-but-armed**: a phase has been chosen and is showing
   * its full duration, but no time is accruing and `start()` will begin it. `TimerState`
   * stays honest because `status` is still `'idle'`, `elapsedMs` is 0 and the anchor is
   * zeroed — the contract only forbids the reverse (a null kind while not idle).
   */
  let kind: SessionKind | null = null

  /** Snapshotted when the phase begins: a mid-phase settings edit must not move the goal. */
  let plannedMs: number | null = null

  let anchor: TimerAnchor = IDLE_ANCHOR
  let focusRoundsCompleted = 0
  let taskId: number | null = null
  let projectId: number | null = null
  let interrupted = false

  let suspendedAt: number | null = null
  let ticker: ReturnType<typeof setInterval> | null = null

  // ── derivation ─────────────────────────────────────────────────────────────

  function derive(t: number): TimerState {
    // While idle the anchor is meaningless, so elapsed is pinned at 0 rather than derived —
    // otherwise an armed phase would appear to run.
    const elapsedMs = status === 'idle' ? 0 : elapsedMsOf(anchor, t)
    const settings = deps.getSettings()
    const inFlowFocus = status !== 'idle' && mode === 'flowmodoro' && kind === 'focus'

    return {
      mode,
      status,
      kind,
      plannedMs,
      startedAt: anchor.startedAt,
      pausedAt: anchor.pausedAt,
      pausedTotalMs: anchor.pausedTotalMs,
      elapsedMs,
      remainingMs: remainingMsOf(plannedMs, elapsedMs),
      earnedBreakMs: inFlowFocus ? computeEarnedBreakMs(elapsedMs, settings) : null,
      progress: progressOf(plannedMs, elapsedMs),
      focusRoundsCompleted,
      longBreakEvery: settings.longBreakEvery,
      taskId,
      projectId,
      interrupted
    }
  }

  function publish(t: number): TimerState {
    const state = derive(t)
    deps.broadcast(EV.timerTick, state)
    return state
  }

  // ── the interval ───────────────────────────────────────────────────────────

  function ensureTicking(): void {
    if (ticker != null) return
    ticker = setInterval(onInterval, TICK_MS)
  }

  function stopTicking(): void {
    if (ticker == null) return
    clearInterval(ticker)
    ticker = null
  }

  function onInterval(): void {
    tickNow()
  }

  // ── transitions ────────────────────────────────────────────────────────────

  function beginPhase(k: SessionKind, planned: number | null, t: number): void {
    kind = k
    plannedMs = planned
    status = 'running'
    anchor = { startedAt: t, pausedAt: null, pausedTotalMs: 0 }
    interrupted = false
    ensureTicking()
  }

  /** Chosen but not started: what the machine sits in when auto-start is off. */
  function armPhase(k: SessionKind, planned: number | null): void {
    kind = k
    plannedMs = planned
    status = 'idle'
    anchor = IDLE_ANCHOR
    interrupted = false
    stopTicking()
  }

  function goIdle(): void {
    kind = null
    plannedMs = null
    status = 'idle'
    anchor = IDLE_ANCHOR
    interrupted = false
    stopTicking()
  }

  function assignTask(id: number | null): void {
    taskId = id
    projectId = deps.getProjectIdForTask(id)
  }

  function logSession(row: SessionCreate): number | null {
    if (row.actualMs < MIN_LOGGED_MS) return null
    return deps.createSession(row).id
  }

  interface EndOptions {
    /** Reached its plan, or (Flowmodoro focus) the user chose to stop. */
    completed: boolean
    /** Write no session row. */
    discard: boolean
    /** Sequence the next phase; false returns to plain idle. */
    advance: boolean
    t: number
  }

  function endPhase(o: EndOptions): void {
    const endedKind = kind
    if (endedKind == null) return

    // An armed-but-unstarted phase has no time and no row to write.
    const wasArmed = status === 'idle'
    const endedPlannedMs = plannedMs
    const endedInterrupted = interrupted
    const endedMode = mode
    const startedAt = anchor.startedAt

    const rawElapsed = wasArmed ? 0 : elapsedMsOf(anchor, o.t)
    // A bounded phase cannot legitimately exceed its plan — the excess is a late tick or a
    // machine that slept through a break, and logging it would inflate the stats.
    const actualMs = endedPlannedMs == null ? rawElapsed : Math.min(rawElapsed, endedPlannedMs)

    const sessionId =
      o.discard || wasArmed
        ? null
        : logSession({
            taskId,
            projectId,
            mode: endedMode,
            kind: endedKind,
            startedAt,
            endedAt: o.t,
            // Already null for Flowmodoro focus, which has no plan by definition.
            plannedMs: endedPlannedMs,
            actualMs,
            completed: o.completed,
            interrupted: endedInterrupted,
            notes: null
          })

    const settings = deps.getSettings()
    let nextKind: SessionKind | null = null
    let nextPlannedMs: number | null = null
    let autoStarted = false

    if (o.advance) {
      const next = nextPhase({
        mode: endedMode,
        endedKind,
        focusRoundsCompleted,
        focusElapsedMs: endedKind === 'focus' ? actualMs : 0,
        settings
      })
      focusRoundsCompleted = next.focusRoundsCompleted
      nextKind = next.kind
      nextPlannedMs = next.plannedMs

      // A bounded phase of 0 ms would expire on the tick that starts it; arming it instead
      // means a broken setting stalls the machine rather than spinning it.
      autoStarted =
        shouldAutoStart(next.kind, settings) && (next.plannedMs == null || next.plannedMs > 0)

      if (autoStarted) beginPhase(next.kind, next.plannedMs, o.t)
      else armPhase(next.kind, next.plannedMs)
    } else {
      goIdle()
    }

    const event: PhaseEndEvent = {
      sessionId,
      mode: endedMode,
      kind: endedKind,
      actualMs,
      plannedMs: endedPlannedMs,
      completed: o.completed,
      interrupted: endedInterrupted,
      taskId,
      nextKind,
      nextPlannedMs,
      autoStarted
    }
    deps.broadcast(EV.timerPhaseEnd, event)
    publish(o.t)
  }

  function tickNow(): TimerState {
    const t = clock()

    if (status === 'running' && isExpired(plannedMs, elapsedMsOf(anchor, t))) {
      endPhase({ completed: true, discard: false, advance: true, t })
      return derive(t)
    }

    return publish(t)
  }

  // ── commands ───────────────────────────────────────────────────────────────

  function resume(): TimerState {
    const t = clock()
    const pausedAt = anchor.pausedAt
    if (status !== 'paused' || pausedAt == null) return derive(t)

    anchor = {
      startedAt: anchor.startedAt,
      pausedAt: null,
      // Math.max guards a backwards clock step during the pause.
      pausedTotalMs: anchor.pausedTotalMs + Math.max(0, t - pausedAt)
    }
    status = 'running'
    ensureTicking()
    return publish(t)
  }

  function skip(): TimerState {
    const t = clock()
    // Nothing live to skip. An armed phase is cleared with stop(), not skipped — advancing
    // past an armed focus would bank a round the user never worked.
    if (kind == null || status === 'idle') return derive(t)

    const elapsed = elapsedMsOf(anchor, t)
    // Flowmodoro focus has no plan to fall short of, so the user ending it counts as done.
    const completed =
      (mode === 'flowmodoro' && kind === 'focus') || isExpired(plannedMs, elapsed)

    endPhase({ completed, discard: false, advance: true, t })
    return derive(t)
  }

  const service: TimerService = {
    getState: () => derive(clock()),

    start(taskIdArg) {
      const t = clock()
      // undefined means "leave the task alone"; null means "clear it".
      if (taskIdArg !== undefined) assignTask(taskIdArg)

      if (status === 'paused') return resume()
      if (status === 'running') return publish(t)

      const armedKind = kind
      if (armedKind != null) {
        // Honour the armed phase and its snapshotted plan — a Flowmodoro break's duration
        // was earned and must not be recomputed from current settings.
        beginPhase(armedKind, plannedMs, t)
      } else {
        beginPhase('focus', initialPlannedMs(mode, 'focus', deps.getSettings()), t)
      }
      return publish(t)
    },

    pause() {
      const t = clock()
      if (status !== 'running') return derive(t)

      anchor = { ...anchor, pausedAt: t }
      status = 'paused'
      stopTicking()
      return publish(t)
    },

    resume,

    takeBreak() {
      const t = clock()
      if (status !== 'idle' && mode === 'flowmodoro' && kind === 'focus') {
        endPhase({ completed: true, discard: false, advance: true, t })
        return derive(t)
      }
      // Pomodoro has no earned break, so this is just "end this phase".
      return skip()
    },

    skip,

    stop(discard = false) {
      const t = clock()
      if (status === 'idle') {
        // Clears an armed phase; nothing ended, so no phase-end event.
        goIdle()
        return publish(t)
      }
      endPhase({ completed: false, discard, advance: false, t })
      return derive(t)
    },

    setMode(nextMode, onRunning = 'keep') {
      const t = clock()

      if (status !== 'idle') {
        endPhase({ completed: false, discard: onRunning === 'discard', advance: false, t })
      } else {
        goIdle()
      }

      mode = nextMode
      // The two modes count rounds differently; carrying a partial cycle across would be
      // meaningless. Persisting `mode` itself is the integration layer's job.
      focusRoundsCompleted = 0
      return publish(t)
    },

    setTask(id) {
      const t = clock()
      assignTask(id)
      return publish(t)
    },

    tick: tickNow,

    handleSuspend() {
      suspendedAt = clock()
    },

    handleResume() {
      const at = suspendedAt
      suspendedAt = null

      // A paused timer cannot be interrupted — its elapsed is already frozen, and the pause
      // itself absorbs the gap on resume().
      if (at != null && status === 'running') {
        const t = clock()
        const before = elapsedMsOf(anchor, t)
        const adjusted = applySleepGap(before, Math.max(0, t - at), deps.getSettings().sleepGraceMs)

        if (adjusted.interrupted) {
          interrupted = true

          // Only focus time is given back. A break slept through is simply over: tickNow()
          // below ends it, and its logged actualMs is capped at its plan.
          if (kind === 'focus') {
            // Fold the lost time into pausedTotalMs so elapsed stays a pure anchor delta
            // rather than a stored number that can drift. Using the difference the math
            // returned rather than the raw gap respects its floor at 0.
            anchor = {
              ...anchor,
              pausedTotalMs: anchor.pausedTotalMs + (before - adjusted.elapsedMs)
            }
          }
        }
      }

      return tickNow()
    },

    dispose: stopTicking
  }

  return service
}
