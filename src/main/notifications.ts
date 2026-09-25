/**
 * Phase-end toasts.
 *
 * The copy carries the actual numbers from the `PhaseEndEvent` — "Focus complete — 52m /
 * Take a 10m break" tells you what to do next, where "Timer finished" makes you open the
 * window to find out. Nothing here reads the timer; everything comes from the event, so a
 * toast can never disagree with the session that was just written.
 */

import { Notification } from 'electron'
import type { PhaseEndEvent, Settings } from '@shared/types'
import { showMainWindow } from './windows'

export interface NotificationDeps {
  getSettings(): Settings
}

let deps: NotificationDeps | null = null
let supported = false

/** Live toasts, so a shutdown mid-break doesn't leave one hanging in Action Center. */
const active = new Set<Notification>()

export function initNotifications(injected: NotificationDeps): void {
  deps = injected

  // Windows needs the AppUserModelId set before this reports true; index.ts does that in
  // whenReady, which is also where this init is called from.
  supported = Notification.isSupported()
  if (!supported) {
    console.warn('[notifications] not supported on this platform; phase-end toasts disabled')
  }
}

/**
 * `nextPlannedMs` defaults to the value already on the event; the parameter exists because
 * the caller may have recomputed the next phase after settings changed mid-session.
 */
export function notifyPhaseEnd(event: PhaseEndEvent, nextPlannedMs?: number | null): void {
  const settings = deps?.getSettings()
  if (!settings?.notificationsEnabled) return

  const next = nextPlannedMs === undefined ? event.nextPlannedMs : nextPlannedMs
  const { title, body } = composePhaseEnd(event, next)

  if (!supported) return

  // Always silent: the renderer's synthesised chime (lib/sounds.ts, gated on
  // settings.soundEnabled independently of this toast) is the only sound for the event —
  // a second, OS-level sound here would double up.
  const toast = new Notification({ title, body, silent: true })

  toast.on('click', () => showMainWindow())
  toast.on('close', () => active.delete(toast))
  toast.on('failed', () => active.delete(toast))

  active.add(toast)
  toast.show()
}

export function disposeNotifications(): void {
  for (const toast of active) toast.close()
  active.clear()
  deps = null
  supported = false
}

export interface ToastCopy {
  title: string
  body: string
}

/** Exported for verification — pure, so the wording is checkable without showing a toast. */
export function composePhaseEnd(event: PhaseEndEvent, nextPlannedMs: number | null): ToastCopy {
  const actual = formatDuration(event.actualMs)

  if (event.kind === 'focus') {
    const title = event.completed ? `Focus complete — ${actual}` : `Focus ended early — ${actual}`
    return { title, body: focusBody(event, nextPlannedMs) }
  }

  const title = event.kind === 'long_break' ? `Long break over — ${actual}` : `Break over — ${actual}`
  return { title, body: breakBody(event, nextPlannedMs) }
}

function focusBody(event: PhaseEndEvent, nextPlannedMs: number | null): string {
  if (event.interrupted) {
    return 'Your machine slept during this one, so the gap was left out of your total.'
  }
  if (event.nextKind === null) {
    return 'Back to idle — nice work.'
  }

  const label = event.nextKind === 'long_break' ? 'long break' : 'break'
  if (nextPlannedMs === null) return event.autoStarted ? `Your ${label} has started.` : `Time for a ${label}.`

  const duration = formatDuration(nextPlannedMs)
  return event.autoStarted
    ? `Your ${duration} ${label} has started.`
    : `Take a ${duration} ${label}.`
}

function breakBody(event: PhaseEndEvent, nextPlannedMs: number | null): string {
  if (event.nextKind !== 'focus') return 'Back to idle.'

  if (event.autoStarted) {
    return nextPlannedMs === null
      ? 'Focus started — stop whenever you lose the thread.'
      : `A ${formatDuration(nextPlannedMs)} focus session has started.`
  }

  return nextPlannedMs === null
    ? 'Ready for another focus session?'
    : `Ready for another ${formatDuration(nextPlannedMs)} focus session?`
}

/** Human durations for prose: `45s`, `52m`, `1h 05m`. Not the tray's `MM:SS`. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`

  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours === 0) return `${minutes}m`

  return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, '0')}m`
}
