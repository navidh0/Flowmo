/**
 * `src/main/miniAuto.ts` — when the mini widget opens and closes itself around the main
 * window leaving and coming back, and that it never closes a widget the user pinned.
 */

import { describe, expect, it } from 'vitest'
import { createMiniAuto } from '../src/main/miniAuto'

function harness(
  initial: {
    showMiniWidget?: boolean
    miniWidgetOnMinimize?: boolean
    open?: boolean
    /** The main window's real state `mainLeft`/`mainReturned` will see when first called. */
    away?: boolean
  } = {}
) {
  const settings = {
    showMiniWidget: initial.showMiniWidget ?? false,
    miniWidgetOnMinimize: initial.miniWidgetOnMinimize ?? true
  }
  let open = initial.open ?? settings.showMiniWidget
  // Defaults to true so every existing call site — which calls mainLeft() expecting it to
  // behave like a genuine departure — keeps working without having to set this explicitly.
  let away = initial.away ?? true
  const calls: string[] = []
  const auto = createMiniAuto({
    getSettings: () => settings,
    isMiniOpen: () => open,
    isMainAway: () => away,
    openMini: () => {
      open = true
      calls.push('open')
    },
    closeMini: () => {
      open = false
      calls.push('close')
    }
  })
  return {
    auto,
    settings,
    calls,
    isOpen: () => open,
    setOpen: (v: boolean) => (open = v),
    setAway: (v: boolean) => (away = v)
  }
}

describe('miniAuto', () => {
  it('opens on leave and closes on return', () => {
    const h = harness()
    h.auto.mainLeft()
    expect(h.isOpen()).toBe(true)
    h.setAway(false)
    h.auto.mainReturned()
    expect(h.isOpen()).toBe(false)
    expect(h.calls).toEqual(['open', 'close'])
  })

  it('opens once when minimize and hide both fire', () => {
    const h = harness()
    h.auto.mainLeft()
    h.auto.mainLeft()
    h.setAway(false)
    h.auto.mainReturned()
    h.auto.mainReturned()
    expect(h.calls).toEqual(['open', 'close'])
  })

  it('does nothing when the option is off', () => {
    const h = harness({ miniWidgetOnMinimize: false })
    h.auto.mainLeft()
    h.setAway(false)
    h.auto.mainReturned()
    expect(h.calls).toEqual([])
  })

  it('never closes a pinned widget', () => {
    const h = harness({ showMiniWidget: true })
    h.auto.mainLeft()
    h.setAway(false)
    h.auto.mainReturned()
    expect(h.calls).toEqual([])
    expect(h.isOpen()).toBe(true)
  })

  it('keeps a widget the user pins while it is auto-shown', () => {
    const h = harness()
    h.auto.mainLeft()
    h.settings.showMiniWidget = true
    h.auto.pinChanged()
    h.setAway(false)
    h.auto.mainReturned()
    expect(h.isOpen()).toBe(true)
    expect(h.calls).toEqual(['open'])
  })

  it('does not reopen after the user closes an auto-shown widget, until the next departure', () => {
    const h = harness()
    h.auto.mainLeft()
    // The tray toggle closes it: the pin (false) now owns it.
    h.setOpen(false)
    h.auto.pinChanged()
    h.setAway(false)
    h.auto.mainReturned()
    expect(h.calls).toEqual(['open'])
    h.setAway(true)
    h.auto.mainLeft()
    expect(h.isOpen()).toBe(true)
  })

  it('switching the option off puts away the widget it opened', () => {
    const h = harness()
    h.auto.mainLeft()
    h.settings.miniWidgetOnMinimize = false
    h.auto.disabled()
    expect(h.isOpen()).toBe(false)
    expect(h.auto.ownsMini()).toBe(false)
  })

  it('leaves an already-open, unpinned widget alone on return', () => {
    // Defensive: a widget that was open for any other reason when the window left is not
    // this module's to close.
    const h = harness({ open: true })
    h.auto.mainLeft()
    h.setAway(false)
    h.auto.mainReturned()
    expect(h.calls).toEqual([])
  })

  // ── Reordered/duplicate Windows minimize↔restore signals ──────────────────────────────
  //
  // On Windows, minimize()/restore() called in quick succession — exactly what the e2e mini
  // suite does, and what a user does double-clicking the taskbar icon — can deliver the two
  // native events out of order, or deliver a second, belated one after the pair has already
  // resolved (the animation's completion signal arriving late). `mainLeft`/`mainReturned`
  // must treat the window's actual current state (`isMainAway`) as authoritative over which
  // named event fired, or a stale signal mutates state nothing will ever undo: the widget
  // opens after the window is already back, and no further close is coming.

  it('ignores a return signal delivered before the real departure (reordered events)', () => {
    const h = harness()
    // 'restore' is delivered first, but the window's real state already agrees with it — it
    // never actually left yet, so there is nothing to close.
    h.setAway(false)
    h.auto.mainReturned()
    expect(h.calls).toEqual([])
    expect(h.isOpen()).toBe(false)
    // The paired departure signal is the belated one this time. By the time it arrives the
    // window's real state is unchanged (still not away) — it must be ignored, not open a
    // widget nothing will later close.
    h.auto.mainLeft()
    expect(h.calls).toEqual([])
    expect(h.isOpen()).toBe(false)
  })

  it('ignores a duplicate departure signal that arrives after a genuine return (reordered events)', () => {
    const h = harness()
    h.auto.mainLeft()
    expect(h.isOpen()).toBe(true)
    h.setAway(false)
    h.auto.mainReturned()
    expect(h.isOpen()).toBe(false)
    // A second 'minimize' notification for the same, already-resolved departure arrives
    // late; the window's real state is still "returned" at that moment.
    h.auto.mainLeft()
    expect(h.calls).toEqual(['open', 'close'])
    expect(h.isOpen()).toBe(false)
    expect(h.auto.ownsMini()).toBe(false)
  })
})
