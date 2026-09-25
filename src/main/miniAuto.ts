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
      const s = deps.getSettings()
      // Minimize and hide can both fire for one departure; the second is a no-op.
      if (!s.miniWidgetOnMinimize || s.showMiniWidget || deps.isMiniOpen()) return
      deps.openMini()
      owned = true
    },

    mainReturned: closeIfOwned,
    disabled: closeIfOwned,

    pinChanged() {
      owned = false
    },

    ownsMini() {
      return owned
    }
  }
}
