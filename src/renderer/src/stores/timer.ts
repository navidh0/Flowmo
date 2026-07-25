/**
 * Renderer-side mirror of the main-process timer.
 *
 * Deliberately holds NO clock of its own. Every number the UI shows arrives pre-derived in
 * a `TimerState` broadcast from main, which computes it as a wall-clock delta against the
 * session anchor. A renderer-side `setInterval` would drift the moment Chromium throttles
 * this window — which is exactly when a focus timer needs to still be right.
 *
 * Subscriptions are reference-counted at module scope rather than tied to one component,
 * because React StrictMode mounts effects twice in dev and the mini widget mounts a second
 * consumer in a second window's renderer. `init()`/`dispose()` may be called in any order
 * and any number of times.
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import { DEFAULT_SETTINGS } from '@shared/types'
import type {
  FlowdoApi,
  OnRunningSession,
  PhaseEndEvent,
  SessionKind,
  Settings,
  TimerMode,
  TimerState
} from '@shared/types'

/** What main reports while nothing is armed or running. Rendered for the frame or two
 *  before `getState()` resolves, so the UI never has to handle a null state. */
export const IDLE_TIMER_STATE: TimerState = {
  mode: DEFAULT_SETTINGS.mode,
  status: 'idle',
  kind: null,
  plannedMs: null,
  startedAt: 0,
  pausedAt: null,
  pausedTotalMs: 0,
  elapsedMs: 0,
  remainingMs: null,
  earnedBreakMs: null,
  progress: 0,
  focusRoundsCompleted: 0,
  longBreakEvery: DEFAULT_SETTINGS.longBreakEvery,
  taskId: null,
  projectId: null,
  interrupted: false
}

/** The bridge is injected by preload, so it can be momentarily absent during a dev reload. */
function bridge(): FlowdoApi | null {
  if (typeof window === 'undefined') return null
  return window.flowdo ?? null
}

interface TimerStore {
  state: TimerState
  settings: Settings
  /** False until the first real snapshot lands; controls are held disabled meanwhile. */
  ready: boolean
  /** Latest phase transition, for transient UI ("focus logged", chimes, etc). */
  lastPhaseEnd: PhaseEndEvent | null

  init: () => void
  dispose: () => void
  refresh: () => Promise<void>

  start: (taskId?: number | null) => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  takeBreak: () => Promise<void>
  skip: () => Promise<void>
  stop: (discard?: boolean) => Promise<void>
  setMode: (mode: TimerMode, onRunning?: OnRunningSession) => Promise<void>
  setTask: (taskId: number | null) => Promise<void>
}

let consumers = 0
let teardown: (() => void) | null = null

export const useTimerStore = create<TimerStore>((set, get) => {
  /** Every command returns the post-command state; storing it keeps the UI correct while
   *  idle/paused, when no ticks are arriving to correct it. */
  async function apply(run: (api: FlowdoApi) => Promise<TimerState>): Promise<void> {
    const api = bridge()
    if (!api) return
    try {
      set({ state: await run(api), ready: true })
    } catch (err) {
      console.error('[timer] command failed', err)
    }
  }

  return {
    state: IDLE_TIMER_STATE,
    settings: DEFAULT_SETTINGS,
    ready: false,
    lastPhaseEnd: null,

    init: () => {
      consumers += 1
      if (teardown) return

      const api = bridge()
      if (!api) return

      const offTick = api.timer.onTick((state) => set({ state, ready: true }))
      const offPhaseEnd = api.timer.onPhaseEnd((lastPhaseEnd) => set({ lastPhaseEnd }))
      const offSettings = api.settings.onChange((settings) => set({ settings }))

      teardown = () => {
        offTick()
        offPhaseEnd()
        offSettings()
      }

      void Promise.all([api.timer.getState(), api.settings.get()])
        .then(([state, settings]) => {
          // A tick can win the race against this snapshot; the tick is newer, so keep it.
          set((prev) => ({ settings, state: prev.ready ? prev.state : state, ready: true }))
        })
        .catch((err) => console.error('[timer] initial load failed', err))
    },

    dispose: () => {
      consumers = Math.max(0, consumers - 1)
      if (consumers > 0) return
      teardown?.()
      teardown = null
    },

    refresh: async () => {
      const api = bridge()
      if (!api) return
      try {
        const [state, settings] = await Promise.all([api.timer.getState(), api.settings.get()])
        set({ state, settings, ready: true })
      } catch (err) {
        console.error('[timer] refresh failed', err)
      }
    },

    /**
     * `undefined` means "leave the task alone" to the timer service, but the preload bridge
     * normalises it to `null` — which the service reads as "clear it". Re-sending the task the
     * state already carries is the only way to express "leave it alone" from here, and without
     * it the attached task silently detaches the moment the user presses Start.
     */
    start: (taskId) =>
      apply((api) => api.timer.start(taskId === undefined ? get().state.taskId : taskId)),
    pause: () => apply((api) => api.timer.pause()),
    resume: () => apply((api) => api.timer.resume()),
    takeBreak: () => apply((api) => api.timer.takeBreak()),
    skip: () => apply((api) => api.timer.skip()),
    stop: (discard) => apply((api) => api.timer.stop(discard)),
    setMode: (mode, onRunning) => apply((api) => api.timer.setMode(mode, onRunning)),
    setTask: (taskId) => apply((api) => api.timer.setTask(taskId))
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

export function initTimerStore(): void {
  useTimerStore.getState().init()
}

export function disposeTimerStore(): void {
  useTimerStore.getState().dispose()
}

/** One-liner for the shell: `useTimerSync()`. Safe to call from several components. */
export function useTimerSync(): void {
  useEffect(() => {
    initTimerStore()
    return disposeTimerStore
  }, [])
}

/**
 * Actions read off the store imperatively. Reading them through a hook would subscribe the
 * component to a store that changes four times a second for no benefit — the action
 * identities never change.
 */
export const timerActions = {
  start: (taskId?: number | null) => void useTimerStore.getState().start(taskId),
  pause: () => void useTimerStore.getState().pause(),
  resume: () => void useTimerStore.getState().resume(),
  takeBreak: () => void useTimerStore.getState().takeBreak(),
  skip: () => void useTimerStore.getState().skip(),
  stop: (discard?: boolean) => void useTimerStore.getState().stop(discard),
  setMode: (mode: TimerMode, onRunning?: OnRunningSession) =>
    void useTimerStore.getState().setMode(mode, onRunning),
  setTask: (taskId: number | null) => void useTimerStore.getState().setTask(taskId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived selectors
// ─────────────────────────────────────────────────────────────────────────────

export const ACCENT_FOCUS = 'var(--color-focus)'
export const ACCENT_BREAK = 'var(--color-break)'

export function isRunning(s: TimerState): boolean {
  return s.status === 'running'
}

export function isPaused(s: TimerState): boolean {
  return s.status === 'paused'
}

/** A session exists — running or paused. Flipping the mode now costs the user something. */
export function isActive(s: TimerState): boolean {
  return s.status !== 'idle'
}

/**
 * Idle-but-armed: main has chosen the next phase and is showing its full duration, but
 * nothing is accruing. Renders as "ready", never as a running timer, and is cleared with
 * `stop()` — `skip()` is a deliberate no-op here.
 */
export function isArmed(s: TimerState): boolean {
  return s.status === 'idle' && s.kind !== null
}

/** Truly nothing chosen and nothing running. */
export function isFresh(s: TimerState): boolean {
  return s.status === 'idle' && s.kind === null
}

export function isBreakKind(kind: SessionKind | null): boolean {
  return kind === 'short_break' || kind === 'long_break'
}

/** Flowmodoro focus: no plan, so it counts up instead of down. */
export function isOpenEnded(s: TimerState): boolean {
  return s.kind === 'focus' && s.plannedMs === null
}

/** Only Flowmodoro focus has a break to cash in. */
export function canTakeBreak(s: TimerState): boolean {
  return s.mode === 'flowmodoro' && s.kind === 'focus' && s.status !== 'idle'
}

export function accentColor(s: TimerState): string {
  return isBreakKind(s.kind) ? ACCENT_BREAK : ACCENT_FOCUS
}

export const MODE_LABEL: Record<TimerMode, string> = {
  pomodoro: 'Pomodoro',
  flowmodoro: 'Flowmodoro'
}

/** Human name for the current phase. Flowmodoro has no long breaks, so its break is just
 *  "Break" — calling it "Short break" implies a long one exists. */
export function phaseName(s: TimerState): string {
  if (s.kind === 'focus') return 'Focus'
  if (s.kind === 'long_break') return 'Long break'
  if (s.kind === 'short_break') return s.mode === 'flowmodoro' ? 'Break' : 'Short break'
  return 'Ready'
}

/** Phase name plus its state, e.g. "Break ready", "Focus · paused". */
export function phaseLabel(s: TimerState): string {
  if (isFresh(s)) return 'Ready'
  if (isArmed(s)) return `${phaseName(s)} ready`
  if (isPaused(s)) return `${phaseName(s)} · paused`
  return phaseName(s)
}

/** True when the next break in the Pomodoro cycle will be the long one. */
export function longBreakNext(s: TimerState): boolean {
  if (s.mode !== 'pomodoro') return false
  const every = s.longBreakEvery > 0 ? s.longBreakEvery : 4
  if (s.kind === 'long_break') return true
  return (s.focusRoundsCompleted + 1) % every === 0
}
