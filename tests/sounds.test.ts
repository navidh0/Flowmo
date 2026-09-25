/**
 * `lib/sounds.ts` — phase-end chimes.
 *
 * `chimeForPhaseEnd` is pure and checked directly. `playChime` touches real Web Audio nodes,
 * so it's exercised against a fake `AudioContext` that records every `createOscillator` /
 * `createGain` / envelope-ramp / `start` / `stop` call — enough to assert *what* would have
 * been scheduled (notes, gain envelope, total length) without an audio backend.
 *
 * A fake bridge on `globalThis.window` stands in for the preload, same technique as
 * tests/timeline-store.test.ts (see that file's header for why); this suite additionally
 * fakes `globalThis.AudioContext` and `globalThis.document` for the same reason — none of
 * them exist under vitest's `node` environment (see vitest.config.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlowdoApi, PhaseEndEvent, Settings } from '@shared/types'

// The module reads `window.flowdo`, typed by src/preload/index.d.ts — which the node
// tsconfig that checks tests/ never sees (see tests/timeline-store.test.ts for why).
declare global {
  interface Window {
    flowdo: FlowdoApi
  }
}

// ── fake Web Audio ──────────────────────────────────────────────────────────────────────

interface RampCall {
  method: 'setValueAtTime' | 'linearRampToValueAtTime' | 'exponentialRampToValueAtTime'
  value: number
  time: number
}

class FakeAudioParam {
  calls: RampCall[] = []
  setValueAtTime(value: number, time: number): void {
    this.calls.push({ method: 'setValueAtTime', value, time })
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ method: 'linearRampToValueAtTime', value, time })
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ method: 'exponentialRampToValueAtTime', value, time })
  }
}

class FakeGainNode {
  gain = new FakeAudioParam()
  connect = vi.fn()
}

class FakeOscillatorNode {
  type = 'sine'
  frequency = { value: 0 }
  connect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}

class FakeAudioContext {
  state: 'running' | 'suspended' = 'running'
  currentTime = 0
  destination = {}
  createGain = vi.fn(() => new FakeGainNode())
  createOscillator = vi.fn(() => new FakeOscillatorNode())
  resume = vi.fn(async () => {
    this.state = 'running'
  })
}

let audioCtor: ReturnType<typeof vi.fn>
let sounds: typeof import('../src/renderer/src/lib/sounds')

beforeEach(async () => {
  vi.resetModules()
  // Must be `function`, not an arrow returning `new FakeAudioContext()`: sounds.ts calls
  // `new Ctor()` directly, and only a real constructor function supports `new`.
  audioCtor = vi.fn(function AudioContext(this: FakeAudioContext) {
    return new FakeAudioContext()
  })
  ;(globalThis as unknown as { AudioContext: unknown }).AudioContext = audioCtor
  ;(globalThis as unknown as { document?: unknown }).document = {
    documentElement: { dataset: {} as Record<string, string> }
  }
  delete (globalThis as { window?: unknown }).window
  sounds = await import('../src/renderer/src/lib/sounds')
})

function lastCtx(): FakeAudioContext {
  return audioCtor.mock.results.at(-1)!.value as FakeAudioContext
}

function event(overrides: Partial<PhaseEndEvent> = {}): PhaseEndEvent {
  return {
    sessionId: 1,
    mode: 'pomodoro',
    kind: 'focus',
    actualMs: 25 * 60_000,
    plannedMs: 25 * 60_000,
    completed: true,
    interrupted: false,
    taskId: null,
    nextKind: 'short_break',
    nextPlannedMs: 5 * 60_000,
    autoStarted: false,
    ...overrides
  }
}

// ── playChime ────────────────────────────────────────────────────────────────────────────

describe('playChime', () => {
  it.each(['toBreak', 'toFocus'] as const)(
    '%s schedules exactly its defined notes, each with a near-silent start/end envelope',
    (name) => {
      const notes = sounds.CHIMES[name]
      const returned = sounds.playChime(name)
      const ctx = lastCtx()

      expect(ctx.createOscillator).toHaveBeenCalledTimes(notes.length)
      expect(ctx.createGain).toHaveBeenCalledTimes(notes.length)

      notes.forEach((note, i) => {
        const osc = ctx.createOscillator.mock.results[i]!.value as FakeOscillatorNode
        const gain = ctx.createGain.mock.results[i]!.value as FakeGainNode

        expect(osc.type).toBe(note.type)
        expect(osc.frequency.value).toBeCloseTo(note.freq)
        expect(osc.start).toHaveBeenCalledWith(note.start)
        expect(osc.stop).toHaveBeenCalledWith(note.start + note.duration + 0.05)
        expect(osc.connect).toHaveBeenCalledWith(gain)
        expect(gain.connect).toHaveBeenCalledWith(ctx.destination)

        // Envelope: near-silent start, ramp up to the note's peak gain, ramp back to
        // near-silent — never a hard start/stop at full gain (no clicks).
        expect(gain.gain.calls).toHaveLength(3)
        const [start, peak, end] = gain.gain.calls as [RampCall, RampCall, RampCall]
        expect(start.method).toBe('setValueAtTime')
        expect(start.value).toBeLessThanOrEqual(0.001)
        expect(start.time).toBeCloseTo(note.start)
        expect(peak.method).toBe('exponentialRampToValueAtTime')
        expect(peak.value).toBeCloseTo(note.gain)
        expect(peak.time).toBeGreaterThan(start.time)
        expect(peak.time).toBeLessThan(note.start + note.duration)
        expect(end.method).toBe('exponentialRampToValueAtTime')
        expect(end.value).toBeLessThanOrEqual(0.001)
        expect(end.time).toBeCloseTo(note.start + note.duration)
      })

      // Total chime length stays inside the ≤ 1.2s budget, and playChime's return value
      // matches chimeLengthSeconds so callers (the settings "Test sound" button) can space
      // a second chime after this one without guessing.
      const length = sounds.chimeLengthSeconds(name)
      expect(length).toBeLessThanOrEqual(1.2)
      expect(returned).toBe(length)
    }
  )

  it('creates the AudioContext lazily, once, and resumes it if suspended', () => {
    expect(audioCtor).not.toHaveBeenCalled()
    sounds.playChime('toBreak')
    expect(audioCtor).toHaveBeenCalledTimes(1)

    const ctx = lastCtx()
    ctx.state = 'suspended'
    sounds.playChime('toFocus')
    expect(audioCtor).toHaveBeenCalledTimes(1) // reused, not recreated
    expect(ctx.resume).toHaveBeenCalledTimes(1)
  })

  it('leaves a read-only breadcrumb on <html> so e2e can assert a chime without hearing it', () => {
    sounds.playChime('toFocus')
    expect(document.documentElement.dataset.lastChime).toBe('toFocus')
  })

  it('is a no-op returning 0 when no AudioContext constructor exists', () => {
    delete (globalThis as { AudioContext?: unknown }).AudioContext
    expect(sounds.playChime('toBreak')).toBe(0)
  })
})

// ── chimeForPhaseEnd ─────────────────────────────────────────────────────────────────────

describe('chimeForPhaseEnd', () => {
  it('focus ending on its own → toBreak', () => {
    expect(sounds.chimeForPhaseEnd(event({ kind: 'focus' }))).toBe('toBreak')
  })

  it('a break ending on its own → toFocus (short and long break alike)', () => {
    expect(
      sounds.chimeForPhaseEnd(event({ kind: 'short_break', nextKind: 'focus' }))
    ).toBe('toFocus')
    expect(
      sounds.chimeForPhaseEnd(event({ kind: 'long_break', nextKind: 'focus' }))
    ).toBe('toFocus')
  })

  it('a Stop before completion (Pomodoro) → no chime', () => {
    // Pomodoro: `completed` is only true once the phase reaches its plan (see
    // src/main/timer.ts#isPhaseComplete). Stop/Skip before then is completed: false —
    // an abandoned phase, not one that earns a "well done" chime.
    expect(sounds.chimeForPhaseEnd(event({ kind: 'focus', completed: false }))).toBeNull()
  })

  it('an interrupted phase (machine slept through it) → no chime', () => {
    expect(
      sounds.chimeForPhaseEnd(event({ kind: 'focus', completed: true, interrupted: true }))
    ).toBeNull()
  })

  it('a Flowmodoro focus stop → chimes (completed is always true there; stopping IS how it ends)', () => {
    // Flowmodoro focus has no plan to fall short of, so `completed` is always true however
    // the phase ends (frozen contract, PhaseEndEvent.completed) — "the user chose to stop"
    // is the phase's normal, intended completion, not an abandonment like a Pomodoro Stop.
    // So this chimes, consistent with the `completed && !interrupted` rule.
    expect(
      sounds.chimeForPhaseEnd(
        event({ mode: 'flowmodoro', kind: 'focus', completed: true, interrupted: false })
      )
    ).toBe('toBreak')
  })
})

// ── initPhaseSounds ──────────────────────────────────────────────────────────────────────

interface FakeApi {
  bridge: FlowdoApi
  fire: (e: PhaseEndEvent) => void
  unsubscribeCalls: number
}

function fakeFlowdo(): FakeApi {
  let handler: ((e: PhaseEndEvent) => void) | null = null
  let unsubscribeCalls = 0
  const bridge = {
    timer: {
      onPhaseEnd: vi.fn((cb: (e: PhaseEndEvent) => void) => {
        handler = cb
        return () => {
          unsubscribeCalls += 1
        }
      })
    }
  } as unknown as FlowdoApi
  return {
    bridge,
    fire: (e) => handler?.(e),
    get unsubscribeCalls() {
      return unsubscribeCalls
    }
  }
}

describe('initPhaseSounds', () => {
  it('plays nothing when settings.soundEnabled is false', () => {
    const fake = fakeFlowdo()
    ;(globalThis as { window?: unknown }).window = { flowdo: fake.bridge }

    const getSettings = (): Settings => ({ soundEnabled: false }) as unknown as Settings
    sounds.initPhaseSounds(getSettings)

    fake.fire(event({ kind: 'focus', completed: true, interrupted: false }))

    expect(audioCtor).not.toHaveBeenCalled()
  })

  it('plays the matching chime when settings.soundEnabled is true', () => {
    const fake = fakeFlowdo()
    ;(globalThis as { window?: unknown }).window = { flowdo: fake.bridge }

    const getSettings = (): Settings => ({ soundEnabled: true }) as unknown as Settings
    sounds.initPhaseSounds(getSettings)

    fake.fire(event({ kind: 'short_break', nextKind: 'focus', completed: true, interrupted: false }))

    const ctx = lastCtx()
    expect(ctx.createOscillator).toHaveBeenCalledTimes(sounds.CHIMES.toFocus.length)
  })

  it('re-reads settings on every event, so flipping the toggle off takes effect immediately', () => {
    const fake = fakeFlowdo()
    ;(globalThis as { window?: unknown }).window = { flowdo: fake.bridge }

    let soundEnabled = true
    sounds.initPhaseSounds(() => ({ soundEnabled }) as unknown as Settings)

    fake.fire(event({ kind: 'focus' }))
    expect(audioCtor).toHaveBeenCalledTimes(1)

    soundEnabled = false
    fake.fire(event({ kind: 'focus' }))
    expect(audioCtor).toHaveBeenCalledTimes(1) // unchanged — no second context created
  })

  it('never chimes an abandoned (not-completed) phase even with sound on', () => {
    const fake = fakeFlowdo()
    ;(globalThis as { window?: unknown }).window = { flowdo: fake.bridge }
    sounds.initPhaseSounds(() => ({ soundEnabled: true }) as unknown as Settings)

    fake.fire(event({ kind: 'focus', completed: false }))

    expect(audioCtor).not.toHaveBeenCalled()
  })

  it('returns the bridge unsubscribe function', () => {
    const fake = fakeFlowdo()
    ;(globalThis as { window?: unknown }).window = { flowdo: fake.bridge }

    const dispose = sounds.initPhaseSounds(() => null)
    dispose()

    expect(fake.unsubscribeCalls).toBe(1)
  })

  it('is a harmless no-op when window.flowdo is unavailable', () => {
    // globalThis.window is deleted in beforeEach — nothing to wire up.
    const dispose = sounds.initPhaseSounds(() => ({ soundEnabled: true }) as unknown as Settings)
    expect(() => dispose()).not.toThrow()
  })
})
