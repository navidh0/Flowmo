/**
 * Phase-end chimes — synthesised at runtime with the Web Audio API. No audio assets: every
 * note is an OscillatorNode driven by a GainNode envelope, so the whole feature ships as
 * source code (CC0 by construction, zero bytes of media in the bundle).
 *
 * Two chimes, keyed by which phase just ended (not what comes next — see `chimeForPhaseEnd`):
 *   - `toBreak`  focus ended, e.g. into a break (or, rarely, straight to idle). A short
 *     rising three-note figure — climbing pitch reads as "you're done, go rest".
 *   - `toFocus`  a break ended, back to focus (or idle). A soft two-partial bell with a
 *     falling resolve note — settling pitch reads as "time to settle back in", and is
 *     deliberately less energetic than `toBreak` so it doesn't feel like a start gun.
 *
 * Only `chimeForPhaseEnd`'s decision is exercised without an AudioContext: `playChime`
 * touches real Web Audio nodes, so it's tested against a fake AudioContext (see
 * tests/sounds.test.ts) rather than by asserting on sound.
 */

import type { PhaseEndEvent, Settings } from '@shared/types'

export type ChimeName = 'toBreak' | 'toFocus'

export interface ChimeNote {
  /** Hz. */
  freq: number
  /** Seconds after the chime starts. */
  start: number
  /** Seconds the note rings for, envelope included. */
  duration: number
  /** Peak gain at the top of the attack ramp (0–1). */
  gain: number
  type: OscillatorType
}

/**
 * Every note is authored to start and end near-silent — `playChime` ramps gain
 * exponentially from ~0.0001 up to `gain` and back down to ~0.0001 across each note's own
 * `duration`, so nothing here ever hard-starts or hard-stops at full volume (no clicks).
 * Peak gains stay in the ≈0.2–0.3 range called for; a note's `gain` can sit lower than that
 * when it's a soft harmonic partial rather than the main voice.
 */
export const CHIMES: Record<ChimeName, ChimeNote[]> = {
  toBreak: [
    { freq: 523.25, start: 0.0, duration: 0.5, gain: 0.26, type: 'sine' }, // C5
    { freq: 659.25, start: 0.12, duration: 0.55, gain: 0.24, type: 'sine' }, // E5
    { freq: 783.99, start: 0.24, duration: 0.65, gain: 0.16, type: 'triangle' } // G5, soft top
  ],
  toFocus: [
    { freq: 659.25, start: 0.0, duration: 0.9, gain: 0.28, type: 'sine' }, // E5, main bell voice
    { freq: 523.25, start: 0.0, duration: 0.75, gain: 0.14, type: 'triangle' }, // C5, bell partial
    { freq: 329.63, start: 0.3, duration: 0.55, gain: 0.18, type: 'sine' } // E4, falling resolve
  ]
}

/** How long a chime rings, end to end — the latest note's `start + duration`. */
export function chimeLengthSeconds(name: ChimeName): number {
  return CHIMES[name].reduce((max, note) => Math.max(max, note.start + note.duration), 0)
}

/**
 * Decides which chime (if any) a finished phase earns. Pure — no Settings, no Audio — so
 * this is checkable without a mock AudioContext.
 *
 * Rule: chime only when the phase ended on its own terms — `completed && !interrupted`.
 * A Pomodoro phase the user cut short with Stop/Skip has `completed: false`, and a phase cut
 * short by the machine sleeping has `interrupted: true`; neither should chime, since a chime
 * there would read as "well done" for a session the user (or the OS) actually abandoned.
 * A Flowmodoro focus phase is `completed: true` however it ends (that mode has no plan to
 * fall short of — see the frozen contract on `PhaseEndEvent.completed`), so stopping one
 * intentionally *does* chime: for Flowmodoro, "the user chose to stop" is the only way a
 * focus phase ever finishes, not an abandonment.
 *
 * Which chime plays is keyed by `event.kind` (the phase that just ended), not `nextKind`:
 * a focus phase always gets `toBreak`, a short/long break always gets `toFocus`, even on the
 * rare path back to idle (no next phase) rather than into a phase of the other kind.
 */
export function chimeForPhaseEnd(event: PhaseEndEvent): ChimeName | null {
  if (!event.completed || event.interrupted) return null
  return event.kind === 'focus' ? 'toBreak' : 'toFocus'
}

let ctx: AudioContext | null = null

/** Lazily creates the shared AudioContext on first use, never at module load. */
function getContext(): AudioContext | null {
  if (ctx) return ctx
  const Ctor = (
    globalThis as typeof globalThis & {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
  ).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  return ctx
}

/**
 * Schedules `name`'s notes on the shared AudioContext and returns the chime's length in
 * seconds (so a caller — the settings "test sound" button — can space two chimes apart
 * without guessing). A no-op (returns 0) if Web Audio isn't available at all.
 *
 * Electron's default autoplay policy needs no user gesture, so this never has to be called
 * from inside a click handler for permission's sake — it still schedules fine from a
 * phase-end IPC callback. The `resume()` call is defensive: some platforms create contexts
 * already `'suspended'` until something touches them.
 */
export function playChime(name: ChimeName): number {
  const audio = getContext()
  if (!audio) return 0

  if (audio.state === 'suspended') void audio.resume()

  const base = audio.currentTime
  const MIN_GAIN = 0.0001

  for (const note of CHIMES[name]) {
    const t0 = base + note.start
    // Soft attack: a quarter of the note's life, capped so a long note doesn't linger before
    // its peak. The rest is the exponential decay back toward silence.
    const attack = Math.min(0.04, note.duration * 0.25)

    const osc = audio.createOscillator()
    osc.type = note.type
    osc.frequency.value = note.freq

    const gainNode = audio.createGain()
    gainNode.gain.setValueAtTime(MIN_GAIN, t0)
    gainNode.gain.exponentialRampToValueAtTime(note.gain, t0 + attack)
    gainNode.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + note.duration)

    osc.connect(gainNode)
    gainNode.connect(audio.destination)

    osc.start(t0)
    // A little past the envelope's own end so the last ramp sample actually renders.
    osc.stop(t0 + note.duration + 0.05)
  }

  // A harmless, read-only breadcrumb: lets e2e assert a chime was scheduled without
  // needing to actually listen for it.
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.dataset.lastChime = name
  }

  return chimeLengthSeconds(name)
}

/**
 * Subscribes to phase-end events and plays the matching chime when sound is on. Returns the
 * unsubscribe function straight from the bridge; callers dispose it the same way as every
 * other `on*` subscription (see preload/index.ts's header comment).
 *
 * `getSettings` is a callback rather than a snapshot because this subscribes once and lives
 * for the app's lifetime, while settings can change at any time — reading fresh settings on
 * every event is what lets flipping the Sound toggle off take effect on the very next
 * phase-end without re-subscribing.
 *
 * No route check here: which window this runs in is decided by the caller (App.tsx wires
 * this into the main window only, not the `#/mini` route), so both windows never end up
 * double-playing the same event.
 */
export function initPhaseSounds(getSettings: () => Settings | null): () => void {
  const api = typeof window === 'undefined' ? undefined : window.flowdo
  if (!api) return () => {}

  return api.timer.onPhaseEnd((event) => {
    if (!getSettings()?.soundEnabled) return
    const chime = chimeForPhaseEnd(event)
    if (chime) playChime(chime)
  })
}
