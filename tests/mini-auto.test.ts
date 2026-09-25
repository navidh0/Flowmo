/**
 * `src/main/miniAuto.ts` — when the mini widget opens and closes itself around the main
 * window leaving and coming back, and that it never closes a widget the user pinned.
 */

import { describe, expect, it } from 'vitest'
import { createMiniAuto } from '../src/main/miniAuto'

function harness(initial: { showMiniWidget?: boolean; miniWidgetOnMinimize?: boolean; open?: boolean } = {}) {
  const settings = {
    showMiniWidget: initial.showMiniWidget ?? false,
    miniWidgetOnMinimize: initial.miniWidgetOnMinimize ?? true
  }
  let open = initial.open ?? settings.showMiniWidget
  const calls: string[] = []
  const auto = createMiniAuto({
    getSettings: () => settings,
    isMiniOpen: () => open,
    openMini: () => {
      open = true
      calls.push('open')
    },
    closeMini: () => {
      open = false
      calls.push('close')
    }
  })
  return { auto, settings, calls, isOpen: () => open, setOpen: (v: boolean) => (open = v) }
}

describe('miniAuto', () => {
  it('opens on leave and closes on return', () => {
    const h = harness()
    h.auto.mainLeft()
    expect(h.isOpen()).toBe(true)
    h.auto.mainReturned()
    expect(h.isOpen()).toBe(false)
    expect(h.calls).toEqual(['open', 'close'])
  })

  it('opens once when minimize and hide both fire', () => {
    const h = harness()
    h.auto.mainLeft()
    h.auto.mainLeft()
    h.auto.mainReturned()
    h.auto.mainReturned()
    expect(h.calls).toEqual(['open', 'close'])
  })

  it('does nothing when the option is off', () => {
    const h = harness({ miniWidgetOnMinimize: false })
    h.auto.mainLeft()
    h.auto.mainReturned()
    expect(h.calls).toEqual([])
  })

  it('never closes a pinned widget', () => {
    const h = harness({ showMiniWidget: true })
    h.auto.mainLeft()
    h.auto.mainReturned()
    expect(h.calls).toEqual([])
    expect(h.isOpen()).toBe(true)
  })

  it('keeps a widget the user pins while it is auto-shown', () => {
    const h = harness()
    h.auto.mainLeft()
    h.settings.showMiniWidget = true
    h.auto.pinChanged()
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
    h.auto.mainReturned()
    expect(h.calls).toEqual(['open'])
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
    h.auto.mainReturned()
    expect(h.calls).toEqual([])
  })
})
