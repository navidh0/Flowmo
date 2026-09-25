/**
 * When the mini widget shows itself: while the main window is off screen, if the user asked
 * for that (`Settings.miniWidgetOnMinimize`).
 *
 * The one rule that matters is ownership. A widget this module opened is this module's to
 * close when the main window comes back; a widget the user pinned (`showMiniWidget`), or
 * that was already open, never is. So it remembers whether it opened the current one, and
 * forgets as soon as the user touches the pin — from then on the pin decides.
 *
 * Electron-free and dependency-injected so the rule is unit-tested without a window
 * (`tests/mini-auto.test.ts`); `index.ts` feeds it the main window's minimize/hide and
 * restore/show events.
 */

import type { Settings } from '@shared/types'

export interface MiniAutoDeps {
  getSettings: () => Pick<Settings, 'showMiniWidget' | 'miniWidgetOnMinimize'>
  isMiniOpen: () => boolean
  /**
   * Whether the main window is, right now, actually away (minimized or not visible) rather
   * than restored and shown. On Windows, minimize/restore called in quick succession (exactly
   * what the e2e suite does, and what a user does double-clicking the taskbar icon) can
   * deliver the two events out of order, or deliver a second, belated one after the pair has
   * already resolved — the animation's completion signal arriving late. Trusting the event's
   * name alone (`mainLeft` means "open", `mainReturned` means "close") then acts on a signal
   * that no longer matches reality: a late `mainLeft` reopens a widget after the window is
   * already back, and nothing is left listening to close it again.
   *
   * `mainLeft`/`mainReturned` re-check this at call time so a stale or reordered signal is a
   * no-op instead of a mutation — the window's actual current state is always the source of
   * truth, never which event fired. Callers pass a live query (e.g.
   * `win.isMinimized() || !win.isVisible()`), not a cached value.
   */
  isMainAway: () => boolean
  openMini: () => void
  closeMini: () => void
}

export interface MiniAuto {
  /** The main window was minimized or hidden to the tray. */
  mainLeft(): void
  /** The main window was restored or shown again. */
  mainReturned(): void
  /** The user changed `showMiniWidget` (settings, tray, or IPC): the pin now owns it. */
  pinChanged(): void
  /** `miniWidgetOnMinimize` was switched off: put away a widget this module opened. */
  disabled(): void
  /** Whether the open widget, if any, is one this module opened. */
  ownsMini(): boolean
}

export function createMiniAuto(deps: MiniAutoDeps): MiniAuto {
  let owned = false

  function closeIfOwned(): void {
    if (!owned) return
    owned = false
    if (!deps.getSettings().showMiniWidget && deps.isMiniOpen()) deps.closeMini()
  }

  return {
    mainLeft() {
      // A leave signal that doesn't match the window's actual current state is stale
      // (reordered or a belated duplicate) — see isMainAway's doc comment.
      if (!deps.isMainAway()) return
      const s = deps.getSettings()
      // Minimize and hide can both fire for one departure; the second is a no-op.
      if (!s.miniWidgetOnMinimize || s.showMiniWidget || deps.isMiniOpen()) return
      deps.openMini()
      owned = true
    },

    mainReturned() {
      // Same staleness check in the other direction: a return signal that fires while the
      // window is actually still away does not mean the window is back.
      if (deps.isMainAway()) return
      closeIfOwned()
    },

    disabled: closeIfOwned,

    pinChanged() {
      owned = false
    },

    ownsMini() {
      return owned
    }
  }
}
