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
import type { HotkeyAction, HotkeyFailure, HotkeyProbe, Settings } from '@shared/types'

// Re-exported for main-process callers that already import from here.
export type { HotkeyAction, HotkeyFailure } from '@shared/types'

/**
 * Wayland exposes no global-shortcut protocol, so `globalShortcut.register()` returns
 * true and then nothing ever fires — the worst possible failure, because it looks like
 * success. Detected once at module load: the session type cannot change under a running
 * process.
 *
 * X11 and XWayland sessions are fine; only a native Wayland session is affected.
 */
const GLOBAL_SHORTCUTS_UNAVAILABLE =
  process.platform === 'linux' && process.env['XDG_SESSION_TYPE']?.toLowerCase() === 'wayland'

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

/**
 * True while the settings screen is recording a new combination. Registrations are
 * dropped for the duration so the live shortcuts cannot fire underneath the capture —
 * pressing the skip combination while rebinding start/pause would otherwise skip the timer.
 */
let suspended = false

export function initHotkeys(injected: HotkeyDeps): HotkeyFailure[] {
  deps = injected
  return reregisterHotkeys(injected.getSettings())
}

/** Call on every settings change; re-registering an unchanged accelerator is harmless. */
export function reregisterHotkeys(settings: Settings): HotkeyFailure[] {
  unregisterHotkeys()
  const d = deps
  if (!d) return []

  // Saving a new binding while suspended lands here; it is applied on resume instead.
  if (suspended) return []

  // Report rather than attempt: on Wayland registration reports success and then never
  // fires, so trying and trusting the result would tell the user their hotkey works.
  if (GLOBAL_SHORTCUTS_UNAVAILABLE) {
    failures = ([
      ['startPause', settings.hotkeyStartPause],
      ['skip', settings.hotkeySkip]
    ] as const)
      .filter(([, accelerator]) => accelerator.trim() !== '')
      .map(([action, accelerator]) => ({
        action,
        accelerator: accelerator.trim(),
        reason: 'unavailable' as const
      }))

    if (failures.length > 0) {
      console.warn('[hotkeys] global shortcuts are unavailable under Wayland')
      d.onFailure?.(failures)
    }
    return failures
  }

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

/**
 * Suspend (true) or restore (false) the app's own global shortcuts. Idempotent. Restoring
 * re-registers from the CURRENT settings, so a binding saved during the capture takes
 * effect here rather than the one that was live when recording began.
 */
export function setHotkeysSuspended(value: boolean): void {
  if (value === suspended) return
  suspended = value
  if (value) {
    unregisterHotkeys()
  } else if (deps) {
    reregisterHotkeys(deps.getSettings())
  }
}

/** The failures from the most recent pass — for the settings UI and for diagnostics. */
export function getHotkeyFailures(): HotkeyFailure[] {
  return [...failures]
}

export function getRegisteredHotkeys(): string[] {
  return [...registered]
}

/**
 * Non-destructively test whether an accelerator is available.
 *
 * Registers, reads the result, and immediately unregisters — so the settings UI can tell
 * the user a combination is taken WHILE THEY ARE CHOOSING IT, instead of accepting it and
 * leaving them to discover months later that it never fired.
 *
 * Two things this must not do, both of which would be silent damage:
 *  - Probing an accelerator we already own would unregister our own live shortcut to test
 *    it, then re-register a no-op handler in its place. That case short-circuits to 'free'
 *    without touching the registration — re-choosing your own current binding is fine, and
 *    flagging cross-action conflicts is the settings UI's job, not this function's.
 *  - The unregister runs in a `finally`, so a throw between register and cleanup cannot
 *    leave a stray handler owning a combination the app never uses.
 */
export function probeHotkey(accelerator: string): HotkeyProbe {
  if (GLOBAL_SHORTCUTS_UNAVAILABLE) return 'unavailable'

  const value = accelerator.trim()
  // An empty accelerator is how the user turns a hotkey off, not something to probe.
  if (value === '') return 'free'

  // Ours already. Registering again would succeed and the cleanup would then drop the
  // real binding.
  if (registered.includes(value)) return 'free'

  let acquired = false
  try {
    acquired = globalShortcut.register(value, () => {})
    return acquired ? 'free' : 'taken'
  } catch {
    return 'invalid'
  } finally {
    if (acquired) {
      try {
        globalShortcut.unregister(value)
      } catch {
        /* nothing to release */
      }
    }
  }
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
