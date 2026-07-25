/**
 * Global shortcuts.
 *
 * `globalShortcut.register()` returns false when another running app already owns the
 * combination, and throws outright on a malformed accelerator string — and settings hold
 * user-typed accelerators, so both happen in practice. Every attempt is therefore
 * classified and reported back: a hotkey that silently never fires is worse than one the
 * user is told about.
 */

import { globalShortcut } from 'electron'
import type { Settings } from '@shared/types'

export type HotkeyAction = 'startPause' | 'skip'

export interface HotkeyFailure {
  action: HotkeyAction
  accelerator: string
  /** `taken`: another app owns it. `invalid`: Electron rejected the string. */
  reason: 'taken' | 'invalid'
}

export interface HotkeyDeps {
  getSettings(): Settings
  onStartPause(): void
  onSkip(): void
  /** Called after any registration pass that had failures, so the UI can surface them. */
  onFailure?(failures: HotkeyFailure[]): void
}

let deps: HotkeyDeps | null = null

/** Only the accelerators we own, so we never unregister another module's shortcut. */
let registered: string[] = []
let failures: HotkeyFailure[] = []

export function initHotkeys(injected: HotkeyDeps): HotkeyFailure[] {
  deps = injected
  return reregisterHotkeys(injected.getSettings())
}

/** Call on every settings change; re-registering an unchanged accelerator is harmless. */
export function reregisterHotkeys(settings: Settings): HotkeyFailure[] {
  unregisterHotkeys()
  const d = deps
  if (!d) return []

  failures = [
    register('startPause', settings.hotkeyStartPause, () => d.onStartPause()),
    register('skip', settings.hotkeySkip, () => d.onSkip())
  ].filter((f): f is HotkeyFailure => f !== null)

  if (failures.length > 0) {
    for (const f of failures) {
      console.warn(`[hotkeys] ${f.action} "${f.accelerator}" not registered (${f.reason})`)
    }
    d.onFailure?.(failures)
  }

  return failures
}

export function unregisterHotkeys(): void {
  for (const accelerator of registered) {
    // Guarded: unregistering something we lost ownership of throws on some platforms.
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      /* already gone */
    }
  }
  registered = []
  failures = []
}

/** The failures from the most recent pass — for the settings UI and for diagnostics. */
export function getHotkeyFailures(): HotkeyFailure[] {
  return [...failures]
}

export function getRegisteredHotkeys(): string[] {
  return [...registered]
}

function register(action: HotkeyAction, accelerator: string, handler: () => void): HotkeyFailure | null {
  // An empty accelerator is how the user turns a hotkey off, not a failure.
  const value = accelerator.trim()
  if (value === '') return null

  try {
    if (!globalShortcut.register(value, handler)) {
      return { action, accelerator: value, reason: 'taken' }
    }
  } catch {
    return { action, accelerator: value, reason: 'invalid' }
  }

  registered.push(value)
  return null
}
