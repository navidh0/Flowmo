/**
 * Power integration: keeping the display awake during focus, and telling the timer when
 * the machine actually slept.
 *
 * The blocker is deliberately `prevent-display-sleep` and not `prevent-app-suspension` —
 * the timer derives elapsed time from wall-clock anchors, so it survives suspension on its
 * own and has no reason to stop a laptop closing on the user's behalf. What it can't
 * survive is being blamed for a 25-minute "session" that was mostly sleep, which is what
 * the suspend/resume callbacks exist to correct.
 */

import { powerMonitor, powerSaveBlocker } from 'electron'

export interface PowerDeps {
  /** Machine is going to sleep. Fires before the gap, so record the timestamp now. */
  onSuspend(): void
  /** Machine woke. Compensate the running phase for the gap. */
  onResume(): void
  /** Optional. A lock is NOT a suspend — 30 seconds at the lock screen isn't sleeping. */
  onLock?(): void
  onUnlock?(): void
}

let deps: PowerDeps | null = null
let blockerId: number | null = null

const handleSuspend = (): void => deps?.onSuspend()
const handleResume = (): void => deps?.onResume()
const handleLock = (): void => deps?.onLock?.()
const handleUnlock = (): void => deps?.onUnlock?.()

let listening = false

/** Call after `app.whenReady()` — powerMonitor is unavailable before that. */
export function initPower(injected: PowerDeps): void {
  deps = injected
  if (listening) return

  powerMonitor.on('suspend', handleSuspend)
  powerMonitor.on('resume', handleResume)
  powerMonitor.on('lock-screen', handleLock)
  powerMonitor.on('unlock-screen', handleUnlock)
  listening = true
}

/**
 * Hold the display awake for as long as a focus session is actively running.
 *
 * Idempotent in both directions: the integration layer calls this from the tick handler,
 * so it runs with the same value many times over and must not stack blockers.
 */
export function setFocusActive(active: boolean): void {
  if (active) {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return
    blockerId = powerSaveBlocker.start('prevent-display-sleep')
    return
  }

  if (blockerId === null) return
  if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
  blockerId = null
}

export function isDisplaySleepBlocked(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId)
}

export function disposePower(): void {
  setFocusActive(false)

  if (listening) {
    powerMonitor.off('suspend', handleSuspend)
    powerMonitor.off('resume', handleResume)
    powerMonitor.off('lock-screen', handleLock)
    powerMonitor.off('unlock-screen', handleUnlock)
    listening = false
  }

  deps = null
}
