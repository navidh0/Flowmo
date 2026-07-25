/**
 * The state machine, driven with an explicit clock.
 *
 * The interval is bypassed almost everywhere: `service.tick()` is called by hand so each
 * test states exactly what time it is, which is also the point of the anchor design — the
 * results must not depend on how often anything fired. One test at the bottom exercises the
 * real interval with fake timers to prove it runs while running and stops when it should.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EV } from '@shared/channels'
import { createTimerService, type TimerService } from '../src/main/timer'
import {
  DEFAULT_SETTINGS,
  type PhaseEndEvent,
  type SessionCreate,
  type Settings,
  type TimerState
} from '@shared/types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const T0 = 1_700_000_000_000

interface Harness {
  service: TimerService
  rows: SessionCreate[]
  phaseEnds: PhaseEndEvent[]
  ticks: TimerState[]
  advance(ms: number): void
  setSettings(patch: Partial<Settings>): void
  at(): number
}

function harness(patch: Partial<Settings> = {}): Harness {
  let now = T0
  let settings: Settings = { ...DEFAULT_SETTINGS, ...patch }
  const rows: SessionCreate[] = []
  const phaseEnds: PhaseEndEvent[] = []
  const ticks: TimerState[] = []
  let nextId = 1

  const service = createTimerService({
    getSettings: () => settings,
    createSession: (input) => {
      rows.push(input)
      return { id: nextId++ }
    },
    broadcast: (channel, payload) => {
      if (channel === EV.timerTick) ticks.push(payload as TimerState)
      if (channel === EV.timerPhaseEnd) phaseEnds.push(payload as PhaseEndEvent)
    },
    getProjectIdForTask: (taskId) => (taskId == null ? null : taskId * 10),
    now: () => now
  })

  return {
    service,
    rows,
    phaseEnds,
    ticks,
    advance: (ms) => {
      now += ms
    },
    setSettings: (p) => {
      settings = { ...settings, ...p }
    },
    at: () => now
  }
}

/** Indexed access with noUncheckedIndexedAccess on, without `?.` noise in every assertion. */
function at<T>(list: readonly T[], index: number): T {
  const item = list[index]
  if (item === undefined) throw new Error(`expected an item at index ${index}`)
  return item
}

const pomodoro: Partial<Settings> = { mode: 'pomodoro' }
const flowmodoro: Partial<Settings> = { mode: 'flowmodoro' }

describe('idle', () => {
  it('starts idle with nothing armed', () => {
    const h = harness(pomodoro)
    const state = h.service.getState()

    expect(state.status).toBe('idle')
    expect(state.kind).toBeNull()
    expect(state.mode).toBe('pomodoro')
    expect(state.elapsedMs).toBe(0)
    expect(state.remainingMs).toBeNull()
    expect(state.earnedBreakMs).toBeNull()
    expect(state.progress).toBe(0)
    expect(state.focusRoundsCompleted).toBe(0)
    expect(state.longBreakEvery).toBe(4)
  })

  it('does nothing on pause, resume or skip while idle', () => {
    const h = harness(pomodoro)
    expect(h.service.pause().status).toBe('idle')
    expect(h.service.resume().status).toBe('idle')
    expect(h.service.skip().status).toBe('idle')
    expect(h.rows).toHaveLength(0)
    expect(h.phaseEnds).toHaveLength(0)
  })
})

describe('Pomodoro sequencing', () => {
  it('runs a full four-round cycle and hits the long break on the fourth', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: true, autoStartFocus: true })

    h.service.start(null)
    expect(h.service.getState()).toMatchObject({
      status: 'running',
      kind: 'focus',
      plannedMs: 25 * MINUTE
    })

    for (const round of [0, 1, 2, 3]) {
      h.advance(25 * MINUTE)
      const afterFocus = h.service.tick()

      const expectedBreak = round === 3 ? 'long_break' : 'short_break'
      const expectedBreakMs = round === 3 ? 15 * MINUTE : 5 * MINUTE

      expect(afterFocus.kind).toBe(expectedBreak)
      expect(afterFocus.status).toBe('running')
      expect(afterFocus.plannedMs).toBe(expectedBreakMs)
      expect(afterFocus.focusRoundsCompleted).toBe(round + 1)

      h.advance(expectedBreakMs)
      const afterBreak = h.service.tick()
      expect(afterBreak.kind).toBe('focus')
      expect(afterBreak.status).toBe('running')
      // Rounds survive a short break and reset only after the long one.
      expect(afterBreak.focusRoundsCompleted).toBe(round === 3 ? 0 : round + 1)
    }

    expect(h.rows.map((r) => r.kind)).toEqual([
      'focus',
      'short_break',
      'focus',
      'short_break',
      'focus',
      'short_break',
      'focus',
      'long_break'
    ])
    expect(h.rows.every((r) => r.completed)).toBe(true)
    expect(h.rows.every((r) => r.mode === 'pomodoro')).toBe(true)
    expect(h.rows.every((r) => !r.interrupted)).toBe(true)
    expect(h.rows.filter((r) => r.kind === 'focus').map((r) => r.actualMs)).toEqual([
      25 * MINUTE,
      25 * MINUTE,
      25 * MINUTE,
      25 * MINUTE
    ])
    expect(at(h.rows, 7)).toMatchObject({ plannedMs: 15 * MINUTE, actualMs: 15 * MINUTE })
  })

  it('logs endedAt and startedAt as real wall clock instants', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(25 * MINUTE)
    h.service.tick()

    const row = at(h.rows, 0)
    expect(row.startedAt).toBe(T0)
    expect(row.endedAt).toBe(T0 + 25 * MINUTE)
  })

  it('treats takeBreak as skip, ending the phase short of its plan', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: true })

    h.service.start(null)
    h.advance(10 * MINUTE)
    const state = h.service.takeBreak()

    expect(state.kind).toBe('short_break')
    expect(state.plannedMs).toBe(5 * MINUTE)
    expect(at(h.rows, 0)).toMatchObject({
      kind: 'focus',
      actualMs: 10 * MINUTE,
      plannedMs: 25 * MINUTE,
      completed: false
    })
  })

  it('counts a skip after the plan was already reached as completed', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(25 * MINUTE + 5_000)
    h.service.skip()

    // Overshoot from a late tick is capped at the plan rather than logged.
    expect(at(h.rows, 0)).toMatchObject({ completed: true, actualMs: 25 * MINUTE })
  })
})

describe('auto-start off — idle but armed', () => {
  it('parks the next phase in idle with its full duration showing and no time accruing', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(25 * MINUTE)
    const armed = h.service.tick()

    expect(armed.status).toBe('idle')
    expect(armed.kind).toBe('short_break')
    expect(armed.plannedMs).toBe(5 * MINUTE)
    expect(armed.remainingMs).toBe(5 * MINUTE)
    expect(armed.elapsedMs).toBe(0)
    expect(armed.progress).toBe(0)
    expect(armed.startedAt).toBe(0)

    // Nothing accrues while armed, however long the user takes to press start.
    h.advance(2 * HOUR)
    expect(h.service.getState().elapsedMs).toBe(0)
    expect(h.service.getState().status).toBe('idle')

    const started = h.service.start()
    expect(started).toMatchObject({ status: 'running', kind: 'short_break', elapsedMs: 0 })
    expect(started.startedAt).toBe(T0 + 25 * MINUTE + 2 * HOUR)
  })

  it('reports autoStarted false and the next phase in the phase-end event', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(25 * MINUTE)
    h.service.tick()

    expect(at(h.phaseEnds, 0)).toEqual({
      sessionId: 1,
      mode: 'pomodoro',
      kind: 'focus',
      actualMs: 25 * MINUTE,
      plannedMs: 25 * MINUTE,
      completed: true,
      interrupted: false,
      taskId: null,
      nextKind: 'short_break',
      nextPlannedMs: 5 * MINUTE,
      autoStarted: false
    })
  })

  it('lets stop() clear an armed phase without logging anything', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(25 * MINUTE)
    h.service.tick()
    expect(h.service.getState().kind).toBe('short_break')

    const state = h.service.stop()
    expect(state.status).toBe('idle')
    expect(state.kind).toBeNull()
    expect(h.rows).toHaveLength(1) // the focus row only
    // Nothing ended, so no second phase-end event.
    expect(h.phaseEnds).toHaveLength(1)
    // The cycle position survives — stopping is not the same as finishing a long break.
    expect(state.focusRoundsCompleted).toBe(1)
  })

  it('does not advance past an armed phase on skip', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(25 * MINUTE)
    h.service.tick()

    const state = h.service.skip()
    expect(state.kind).toBe('short_break')
    expect(state.status).toBe('idle')
    expect(state.focusRoundsCompleted).toBe(1)
    expect(h.rows).toHaveLength(1)
  })

  it('honours the defaults: breaks auto-start, focus arms', () => {
    const h = harness(pomodoro) // autoStartBreaks true, autoStartFocus false

    h.service.start(null)
    h.advance(25 * MINUTE)
    expect(h.service.tick()).toMatchObject({ kind: 'short_break', status: 'running' })

    h.advance(5 * MINUTE)
    expect(h.service.tick()).toMatchObject({ kind: 'focus', status: 'idle' })
  })
})

describe('Flowmodoro', () => {
  it('runs an open-ended focus and earns the break from it', () => {
    const h = harness({ ...flowmodoro, autoStartBreaks: true })

    const started = h.service.start(null)
    expect(started.plannedMs).toBeNull()
    expect(started.remainingMs).toBeNull()
    expect(started.progress).toBe(0)
    expect(started.earnedBreakMs).toBe(0)

    h.advance(50 * MINUTE)
    const mid = h.service.getState()
    expect(mid.status).toBe('running')
    expect(mid.elapsedMs).toBe(50 * MINUTE)
    expect(mid.earnedBreakMs).toBe(10 * MINUTE)

    const onBreak = h.service.takeBreak()
    expect(onBreak).toMatchObject({
      kind: 'short_break',
      status: 'running',
      plannedMs: 10 * MINUTE,
      earnedBreakMs: null,
      focusRoundsCompleted: 1
    })

    h.advance(10 * MINUTE)
    const back = h.service.tick()
    expect(back).toMatchObject({ kind: 'focus', plannedMs: null })

    expect(h.rows).toHaveLength(2)
    expect(at(h.rows, 0)).toMatchObject({
      kind: 'focus',
      mode: 'flowmodoro',
      plannedMs: null,
      actualMs: 50 * MINUTE,
      completed: true
    })
    expect(at(h.rows, 1)).toMatchObject({
      kind: 'short_break',
      plannedMs: 10 * MINUTE,
      actualMs: 10 * MINUTE,
      completed: true
    })
  })

  it('never reaches a long break, however many rounds run', () => {
    const h = harness({ ...flowmodoro, autoStartBreaks: true, autoStartFocus: true })

    h.service.start(null)
    for (let i = 0; i < 6; i++) {
      h.advance(25 * MINUTE)
      expect(h.service.takeBreak().kind).toBe('short_break')
      h.advance(5 * MINUTE)
      h.service.tick()
    }
    expect(h.rows.some((r) => r.kind === 'long_break')).toBe(false)
    expect(h.service.getState().focusRoundsCompleted).toBe(6)
  })

  it('treats skip during focus as takeBreak — the user chose to stop, so it counts', () => {
    const h = harness({ ...flowmodoro, autoStartBreaks: true })

    h.service.start(null)
    h.advance(25 * MINUTE)
    const state = h.service.skip()

    expect(state.kind).toBe('short_break')
    expect(state.plannedMs).toBe(5 * MINUTE)
    expect(at(h.rows, 0)).toMatchObject({ kind: 'focus', completed: true, plannedMs: null })
  })

  it('clamps a very short focus up to the minimum break', () => {
    const h = harness({ ...flowmodoro, autoStartBreaks: true })

    h.service.start(null)
    h.advance(10_000)
    expect(h.service.takeBreak().plannedMs).toBe(MINUTE)
  })

  it('keeps the earned duration when an armed break is started much later', () => {
    const h = harness({ ...flowmodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(50 * MINUTE)
    h.service.takeBreak()
    expect(h.service.getState()).toMatchObject({ status: 'idle', plannedMs: 10 * MINUTE })

    // A settings edit in the meantime must not retroactively change a break already earned.
    h.setSettings({ flowmodoroDivisor: 2 })
    h.advance(HOUR)
    expect(h.service.start().plannedMs).toBe(10 * MINUTE)
  })
})

describe('pause and resume', () => {
  it('freezes the displayed elapsed while paused', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(10 * MINUTE)
    const paused = h.service.pause()

    expect(paused.status).toBe('paused')
    expect(paused.pausedAt).toBe(T0 + 10 * MINUTE)
    expect(paused.elapsedMs).toBe(10 * MINUTE)

    h.advance(5 * MINUTE)
    expect(h.service.getState().elapsedMs).toBe(10 * MINUTE)
    h.advance(3 * HOUR)
    expect(h.service.getState().elapsedMs).toBe(10 * MINUTE)
    expect(h.service.getState().earnedBreakMs).toBe(2 * MINUTE)
  })

  it('excludes paused time from actualMs', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(10 * MINUTE)
    h.service.pause()
    h.advance(5 * MINUTE)
    h.service.resume()
    h.advance(10 * MINUTE)
    h.service.stop(false)

    const row = at(h.rows, 0)
    expect(row.actualMs).toBe(20 * MINUTE)
    expect(row.startedAt).toBe(T0)
    expect(row.endedAt).toBe(T0 + 25 * MINUTE)
  })

  it('excludes paused time across several pause cycles', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    for (let i = 0; i < 3; i++) {
      h.advance(6 * MINUTE)
      h.service.pause()
      h.advance(2 * MINUTE)
      h.service.resume()
    }
    expect(h.service.getState().elapsedMs).toBe(18 * MINUTE)
    expect(h.service.getState().pausedTotalMs).toBe(6 * MINUTE)
  })

  it('does not let a pause push a bounded phase past its plan', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(20 * MINUTE)
    h.service.pause()
    h.advance(HOUR)
    // The paused phase must not have expired behind the user's back.
    expect(h.service.tick()).toMatchObject({ status: 'paused', kind: 'focus' })
    expect(h.rows).toHaveLength(0)

    h.service.resume()
    h.advance(5 * MINUTE)
    expect(h.service.tick().kind).toBe('short_break')
    expect(at(h.rows, 0).actualMs).toBe(25 * MINUTE)
  })

  it('resumes through start() as well as resume()', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(MINUTE)
    h.service.pause()
    h.advance(MINUTE)

    const state = h.service.start()
    expect(state.status).toBe('running')
    expect(state.pausedAt).toBeNull()
    expect(state.elapsedMs).toBe(MINUTE)
  })

  it('start() while running does not restart the phase', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(10 * MINUTE)
    const state = h.service.start()

    expect(state.startedAt).toBe(T0)
    expect(state.elapsedMs).toBe(10 * MINUTE)
  })
})

describe('stop', () => {
  it('writes nothing when discarding', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(30 * MINUTE)
    const state = h.service.stop(true)

    expect(h.rows).toHaveLength(0)
    expect(state).toMatchObject({ status: 'idle', kind: null, plannedMs: null, elapsedMs: 0 })
    expect(at(h.phaseEnds, 0)).toMatchObject({
      sessionId: null,
      kind: 'focus',
      actualMs: 30 * MINUTE,
      nextKind: null,
      nextPlannedMs: null,
      autoStarted: false
    })
  })

  it('logs an incomplete session when not discarding', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(30 * MINUTE)
    h.service.stop(false)

    expect(h.rows).toHaveLength(1)
    expect(at(h.rows, 0)).toMatchObject({ actualMs: 30 * MINUTE, completed: false })
    expect(at(h.phaseEnds, 0).sessionId).toBe(1)
  })

  it('defaults to logging', () => {
    const h = harness(flowmodoro)
    h.service.start(null)
    h.advance(30 * MINUTE)
    h.service.stop()
    expect(h.rows).toHaveLength(1)
  })

  it('does not log a sub-second session', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(900)
    h.service.stop(false)

    expect(h.rows).toHaveLength(0)
    expect(at(h.phaseEnds, 0).sessionId).toBeNull()
  })

  it('logs a session of exactly one second', () => {
    const h = harness(flowmodoro)
    h.service.start(null)
    h.advance(1000)
    h.service.stop(false)
    expect(h.rows).toHaveLength(1)
  })

  it('stops the phase from a paused state too', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(10 * MINUTE)
    h.service.pause()
    h.advance(HOUR)
    h.service.stop(false)

    expect(at(h.rows, 0).actualMs).toBe(10 * MINUTE)
    expect(h.service.getState().status).toBe('idle')
  })
})

describe('setMode', () => {
  it("logs the in-flight session with 'keep'", () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(20 * MINUTE)
    const state = h.service.setMode('pomodoro', 'keep')

    expect(h.rows).toHaveLength(1)
    expect(at(h.rows, 0)).toMatchObject({ mode: 'flowmodoro', kind: 'focus', completed: false })
    expect(state).toMatchObject({ mode: 'pomodoro', status: 'idle', kind: null })
  })

  it("drops the in-flight session with 'discard'", () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(20 * MINUTE)
    const state = h.service.setMode('pomodoro', 'discard')

    expect(h.rows).toHaveLength(0)
    expect(state).toMatchObject({ mode: 'pomodoro', status: 'idle' })
  })

  it("defaults to 'keep'", () => {
    const h = harness(flowmodoro)
    h.service.start(null)
    h.advance(20 * MINUTE)
    h.service.setMode('pomodoro')
    expect(h.rows).toHaveLength(1)
  })

  it('always returns to idle and resets the cycle counter', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(25 * MINUTE)
    h.service.tick()
    expect(h.service.getState().focusRoundsCompleted).toBe(1)

    const state = h.service.setMode('flowmodoro')
    expect(state).toMatchObject({ status: 'idle', kind: null, focusRoundsCompleted: 0 })
  })

  it('switches cleanly from idle without logging', () => {
    const h = harness(flowmodoro)
    const state = h.service.setMode('pomodoro')
    expect(h.rows).toHaveLength(0)
    expect(state.mode).toBe('pomodoro')

    h.service.start(null)
    expect(h.service.getState().plannedMs).toBe(25 * MINUTE)
  })
})

describe('task attribution', () => {
  it('resolves the project when a task is set', () => {
    const h = harness(flowmodoro)

    const state = h.service.setTask(7)
    expect(state).toMatchObject({ taskId: 7, projectId: 70 })

    h.service.start()
    h.advance(20 * MINUTE)
    h.service.stop(false)
    expect(at(h.rows, 0)).toMatchObject({ taskId: 7, projectId: 70 })
  })

  it('accepts a task on start()', () => {
    const h = harness(flowmodoro)
    expect(h.service.start(3)).toMatchObject({ taskId: 3, projectId: 30 })
  })

  it('leaves the task alone when start() is called with no argument', () => {
    const h = harness(flowmodoro)
    h.service.setTask(3)
    expect(h.service.start().taskId).toBe(3)
  })

  it('clears the task with null', () => {
    const h = harness(flowmodoro)
    h.service.setTask(3)
    expect(h.service.setTask(null)).toMatchObject({ taskId: null, projectId: null })
  })

  it('re-attributes an in-flight session', () => {
    const h = harness(flowmodoro)

    h.service.start(1)
    h.advance(10 * MINUTE)
    h.service.setTask(2)
    h.service.stop(false)

    expect(at(h.rows, 0)).toMatchObject({ taskId: 2, projectId: 20 })
  })
})

describe('suspend and resume', () => {
  it('gives back a sleep gap beyond grace and flags the session', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: false })

    h.service.start(null)
    h.advance(MINUTE)
    h.service.handleSuspend()
    h.advance(3 * HOUR)
    const state = h.service.handleResume()

    expect(state.status).toBe('running')
    expect(state.kind).toBe('focus')
    expect(state.interrupted).toBe(true)
    expect(state.elapsedMs).toBe(MINUTE)

    h.advance(24 * MINUTE)
    h.service.tick()
    expect(at(h.rows, 0)).toMatchObject({
      kind: 'focus',
      actualMs: 25 * MINUTE,
      interrupted: true,
      completed: true
    })
  })

  it('does not log three hours of focus for a three hour sleep', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(10 * MINUTE)
    h.service.handleSuspend()
    h.advance(3 * HOUR)
    h.service.handleResume()
    h.service.stop(false)

    expect(at(h.rows, 0).actualMs).toBe(10 * MINUTE)
    expect(at(h.rows, 0).interrupted).toBe(true)
  })

  it('treats a gap within grace as continuous work', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(10 * MINUTE)
    h.service.handleSuspend()
    h.advance(90_000) // under the 2 min default grace
    const state = h.service.handleResume()

    expect(state.interrupted).toBe(false)
    expect(state.elapsedMs).toBe(10 * MINUTE + 90_000)
  })

  it('gives back exactly the gap, however large, leaving only the pre-sleep work', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(MINUTE)
    h.service.handleSuspend()
    h.advance(8 * HOUR)
    const state = h.service.handleResume()

    expect(state.elapsedMs).toBe(MINUTE)
    expect(state.earnedBreakMs).toBe(MINUTE) // 12 s earned, clamped up to the 1 min minimum
  })

  it('never drives elapsed negative when the clock steps back during the sleep', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(MINUTE)
    h.service.handleSuspend()
    h.advance(-10 * MINUTE)
    const state = h.service.handleResume()

    expect(state.elapsedMs).toBe(0)
    expect(state.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('ends a break that was slept through instead of extending it', () => {
    const h = harness({ ...pomodoro, autoStartBreaks: true, autoStartFocus: false })

    h.service.start(null)
    h.advance(25 * MINUTE)
    h.service.tick()
    expect(h.service.getState().kind).toBe('short_break')

    h.service.handleSuspend()
    h.advance(3 * HOUR)
    const state = h.service.handleResume()

    expect(state).toMatchObject({ status: 'idle', kind: 'focus' })
    // The break is logged at its planned length, not the three hours of wall clock.
    expect(at(h.rows, 1)).toMatchObject({
      kind: 'short_break',
      actualMs: 5 * MINUTE,
      plannedMs: 5 * MINUTE,
      interrupted: true
    })
  })

  it('leaves a paused timer untouched across a sleep', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(10 * MINUTE)
    h.service.pause()
    h.service.handleSuspend()
    h.advance(3 * HOUR)
    const state = h.service.handleResume()

    expect(state.status).toBe('paused')
    expect(state.elapsedMs).toBe(10 * MINUTE)
    expect(state.interrupted).toBe(false)
  })

  it('is a no-op when resumed while idle', () => {
    const h = harness(flowmodoro)
    h.service.handleSuspend()
    h.advance(3 * HOUR)
    expect(h.service.handleResume().status).toBe('idle')
    expect(h.rows).toHaveLength(0)
  })
})

describe('anchors, not accumulated ticks', () => {
  it('reports wall-clock elapsed after three hours without a single tick', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.advance(3 * HOUR)

    const state = h.service.getState()
    expect(state.elapsedMs).toBe(3 * HOUR)
    expect(state.earnedBreakMs).toBe(30 * MINUTE) // 36 min earned, capped at the max
    expect(state.startedAt).toBe(T0)
  })

  it('is unaffected by how many times tick() ran', () => {
    const sparse = harness(flowmodoro)
    sparse.service.start(null)
    sparse.advance(20 * MINUTE)
    sparse.service.tick()

    const busy = harness(flowmodoro)
    busy.service.start(null)
    for (let i = 0; i < 80; i++) {
      busy.advance(15_000)
      busy.service.tick()
    }

    expect(busy.service.getState().elapsedMs).toBe(sparse.service.getState().elapsedMs)
  })

  it('never reports negative elapsed when the clock steps backwards', () => {
    let now = T0
    const service = createTimerService({
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      createSession: () => ({ id: 1 }),
      broadcast: () => {},
      getProjectIdForTask: () => null,
      now: () => now
    })

    service.start(null)
    now -= 10 * MINUTE
    expect(service.getState().elapsedMs).toBe(0)
  })
})

describe('broadcasts', () => {
  it('pushes a fully derived state on every tick', () => {
    const h = harness({ ...flowmodoro, autoStartBreaks: true })

    h.service.start(null)
    h.advance(50 * MINUTE)
    h.service.tick()
    h.service.takeBreak()

    const last = at(h.ticks, h.ticks.length - 1)
    expect(last).toMatchObject({
      mode: 'flowmodoro',
      status: 'running',
      kind: 'short_break',
      plannedMs: 10 * MINUTE,
      elapsedMs: 0,
      remainingMs: 10 * MINUTE,
      earnedBreakMs: null,
      progress: 0,
      focusRoundsCompleted: 1,
      longBreakEvery: 4
    })
  })

  it('pushes a state on every command', () => {
    const h = harness(flowmodoro)

    h.service.start(null)
    h.service.pause()
    h.service.resume()
    h.service.setTask(1)
    h.service.stop(true)

    expect(h.ticks.map((s) => s.status)).toEqual([
      'running',
      'paused',
      'running',
      'running',
      'idle'
    ])
  })

  it('fills progress and remaining for a bounded phase mid-run', () => {
    const h = harness(pomodoro)

    h.service.start(null)
    h.advance(5 * MINUTE)
    const state = h.service.tick()

    expect(state.remainingMs).toBe(20 * MINUTE)
    expect(state.progress).toBeCloseTo(0.2, 10)
    expect(state.earnedBreakMs).toBeNull() // Pomodoro earns nothing
  })
})

describe('hostile settings', () => {
  it('arms rather than auto-starts a zero-length break, so the machine cannot spin', () => {
    const h = harness({
      ...pomodoro,
      autoStartBreaks: true,
      autoStartFocus: true,
      pomodoroShortBreakMs: 0
    })

    h.service.start(null)
    h.advance(25 * MINUTE)
    const state = h.service.tick()

    expect(state.status).toBe('idle')
    expect(state.kind).toBe('short_break')
    expect(at(h.phaseEnds, 0).autoStarted).toBe(false)
  })

  it('falls back to a long break every 4 when longBreakEvery is 0', () => {
    const h = harness({ ...pomodoro, longBreakEvery: 0, autoStartBreaks: true, autoStartFocus: true })

    h.service.start(null)
    for (const round of [0, 1, 2, 3]) {
      h.advance(25 * MINUTE)
      const state = h.service.tick()
      expect(state.kind).toBe(round === 3 ? 'long_break' : 'short_break')
      h.advance(state.plannedMs ?? 0)
      h.service.tick()
    }
  })
})

describe('the tick interval', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Uses the ambient clock so vi's fake timers move Date.now and the interval together. */
  function intervalHarness() {
    vi.useFakeTimers({ now: T0 })
    const ticks: TimerState[] = []
    const service = createTimerService({
      getSettings: () => ({ ...DEFAULT_SETTINGS, mode: 'pomodoro', autoStartBreaks: false }),
      createSession: () => ({ id: 1 }),
      broadcast: (channel, payload) => {
        if (channel === EV.timerTick) ticks.push(payload as TimerState)
      },
      getProjectIdForTask: () => null
    })
    return { service, ticks }
  }

  it('broadcasts roughly every 250 ms while running', () => {
    const { service, ticks } = intervalHarness()

    service.start(null)
    const afterStart = ticks.length
    vi.advanceTimersByTime(1000)

    expect(ticks.length - afterStart).toBe(4)
    expect(at(ticks, ticks.length - 1).elapsedMs).toBe(1000)

    service.dispose()
  })

  it('stops ticking while paused and starts again on resume', () => {
    const { service, ticks } = intervalHarness()

    service.start(null)
    vi.advanceTimersByTime(500)
    service.pause()

    const whilePaused = ticks.length
    vi.advanceTimersByTime(5000)
    expect(ticks).toHaveLength(whilePaused)

    service.resume()
    vi.advanceTimersByTime(500)
    expect(ticks.length).toBeGreaterThan(whilePaused + 1)

    service.dispose()
  })

  it('stops ticking once idle', () => {
    const { service, ticks } = intervalHarness()

    service.start(null)
    vi.advanceTimersByTime(500)
    service.stop(true)

    const whenIdle = ticks.length
    vi.advanceTimersByTime(10_000)
    expect(ticks).toHaveLength(whenIdle)
  })

  it('ends an expired phase from the interval alone', () => {
    const { service } = intervalHarness()

    service.start(null)
    vi.advanceTimersByTime(25 * MINUTE)

    expect(service.getState()).toMatchObject({ status: 'idle', kind: 'short_break' })

    service.dispose()
  })

  it('leaves no interval running after dispose', () => {
    const { service, ticks } = intervalHarness()

    service.start(null)
    service.dispose()

    const afterDispose = ticks.length
    vi.advanceTimersByTime(10_000)
    expect(ticks).toHaveLength(afterDispose)
  })
})
