/**
 * layout — Settings → Layout's controls do what they say, and the timer panel fits at the
 * smallest window:
 *   - Move left/right reorders the three panels in the DOM, and the order survives a restart;
 *   - Compact density sets data-density and really tightens spacing;
 *   - at the minimum window size (760×560) the timer panel has no horizontal overflow in
 *     either density, and the earned-break card and the switch-mode confirmation both fit
 *     inside it — the two v0.4 layout bugs.
 * Always the throwaway profile.
 */

import { join } from 'node:path'
import { launch, quit, makeProfile, makeReporter, onMain, outDir, sleep, waitFor } from '../lib/harness.mjs'

const MIN_SIZE = { width: 760, height: 560 }

/**
 * The three columns, left to right, as rendered on the Focus screen — the one screen that
 * shows all three (Settings, for one, has no Projects column). Returns to Settings after if
 * asked, since the move buttons live there.
 */
async function panelOrder(page, { backToSettings = false } = {}) {
  await page.click('[aria-label="Focus"]')
  await sleep(300)
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('[data-panel]')].map((el) => el.getAttribute('data-panel'))
  )
  if (backToSettings) {
    await page.click('[aria-label="Settings"]')
    await sleep(300)
  }
  return order
}

/** The timer column's box and whether its scroll container overflows sideways. */
function timerPanel(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-panel="timer"]')
    if (!panel) return null
    const scroller = panel.querySelector('.overflow-y-auto') ?? panel
    const r = panel.getBoundingClientRect()
    return {
      box: { left: r.left, right: r.right, width: r.width },
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth
    }
  })
}

/** Is `selector`'s box inside the timer panel's box (1px tolerance for subpixel rounding)? */
async function insideTimerPanel(page, selector) {
  return page.evaluate((sel) => {
    const panel = document.querySelector('[data-panel="timer"]')
    const el = document.querySelector(sel)
    if (!panel || !el) return { ok: false, reason: `missing ${!panel ? 'panel' : sel}` }
    const p = panel.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    return {
      ok: b.left >= p.left - 1 && b.right <= p.right + 1,
      panel: { left: Math.round(p.left), right: Math.round(p.right) },
      el: { left: Math.round(b.left), right: Math.round(b.right) }
    }
  }, selector)
}

export async function run() {
  const { check, results } = makeReporter('layout')
  const profile = makeProfile('flowdo-e2e-layout-')

  let app
  try {
    let launched = await launch({ profile })
    app = launched.app
    let page = launched.page

    // ── Reorder through the Settings UI ─────────────────────────────────────────
    const before = await panelOrder(page)
    await page.click('[aria-label="Settings"]')
    await sleep(500)
    check('panels start in the default order', before.join() === 'projects,timer,main', before.join())

    await page.click('[aria-label="Move Timer left"]')
    await sleep(400)
    const afterLeft = await panelOrder(page, { backToSettings: true })
    check('Move Timer left puts the timer first', afterLeft.join() === 'timer,projects,main', afterLeft.join())

    await page.click('[aria-label="Move Projects right"]')
    await sleep(400)
    const afterRight = await panelOrder(page, { backToSettings: true })
    check('Move Projects right puts projects last', afterRight.join() === 'timer,main,projects', afterRight.join())

    const disabledEnds = await page.evaluate(() => ({
      firstLeft: document.querySelector('[aria-label="Move Timer left"]')?.disabled,
      lastRight: document.querySelector('[aria-label="Move Projects right"]')?.disabled
    }))
    check('the move buttons are disabled at the ends', disabledEnds.firstLeft === true && disabledEnds.lastRight === true, JSON.stringify(disabledEnds))

    const stored = await page.evaluate(() => window.flowdo.settings.get())
    check('the new order is stored', stored.layout.order.join() === 'timer,main,projects', stored.layout.order.join())
    await page.screenshot({ path: join(outDir, 'layout-settings-reordered.png') })

    await quit(app)
    launched = await launch({ profile })
    app = launched.app
    page = launched.page
    const afterRestart = await panelOrder(page)
    check('the order survives a restart', afterRestart.join() === 'timer,main,projects', afterRestart.join())

    await page.click('[aria-label="Settings"]')
    await sleep(400)
    await page.click('button:has-text("Reset layout")')
    await sleep(400)
    const reset = await panelOrder(page, { backToSettings: true })
    check('Reset layout restores the default order', reset.join() === 'projects,timer,main', reset.join())

    // ── Density ────────────────────────────────────────────────────────────────
    const gap = () =>
      page.evaluate(() => {
        const list = document.querySelector('ul[aria-label="Panel order"]')
        return list ? parseFloat(getComputedStyle(list).rowGap) : null
      })
    const comfortableGap = await gap()
    await page.locator('label:has-text("Density") select').first().selectOption('compact')
    const density = await waitFor(async () =>
      (await page.evaluate(() => document.documentElement.dataset.density)) === 'compact' ? 'compact' : null
    )
    check('Compact sets data-density on <html>', density === 'compact')
    const compactGap = await gap()
    check(
      'Compact really tightens spacing',
      comfortableGap != null && compactGap != null && compactGap < comfortableGap,
      JSON.stringify({ comfortableGap, compactGap })
    )
    const miniDensity = await page.evaluate(() => window.flowdo.settings.get())
    check('the density is stored', miniDensity.density === 'compact', miniDensity.density)
    await page.screenshot({ path: join(outDir, 'layout-settings-compact.png') })

    // ── The timer panel at the minimum window size ─────────────────────────────
    await onMain(app, `w.setBounds({ x: 0, y: 0, width: ${MIN_SIZE.width}, height: ${MIN_SIZE.height} })`)
    await page.click('[aria-label="Focus"]')
    await sleep(600)

    for (const d of ['compact', 'comfortable']) {
      await page.evaluate((v) => window.flowdo.settings.set({ density: v }), d)
      await sleep(400)
      const t = await timerPanel(page)
      check(
        `no sideways scroll in the timer panel at minimum size (${d})`,
        !!t && t.scrollWidth <= t.clientWidth,
        JSON.stringify(t)
      )
      await page.screenshot({ path: join(outDir, `layout-min-${d}.png`) })
    }

    // Earned-break card: a Flowmodoro focus earns it within a couple of seconds.
    await page.evaluate(() => window.flowdo.timer.setMode('flowmodoro', 'discard'))
    await page.evaluate(() => window.flowdo.timer.start())
    await sleep(2200)
    const card = page.locator('text=Break earned').first()
    const cardVisible = await card.isVisible()
    check('earned break card shows at minimum size', cardVisible)
    if (cardVisible) {
      // Tag the card's outer box so its bounds, not the label's, are compared.
      await card.evaluate((el) => el.closest('.rounded-2xl')?.setAttribute('data-e2e', 'earned-break'))
      const fit = await insideTimerPanel(page, '[data-e2e="earned-break"]')
      check('the earned break card fits inside the timer panel', fit.ok, JSON.stringify(fit))
    }

    // Switch-mode confirmation: asked because a session is running.
    await page.click('role=radio[name="Pomodoro"]')
    await sleep(400)
    const confirm = page.locator('text=is in progress').first()
    const confirmVisible = await confirm.isVisible()
    check('switching mode mid-session asks first', confirmVisible)
    if (confirmVisible) {
      await confirm.evaluate((el) => el.closest('.shadow-2xl')?.setAttribute('data-e2e', 'mode-confirm'))
      const fit = await insideTimerPanel(page, '[data-e2e="mode-confirm"]')
      check('the switch-mode confirmation fits inside the timer panel', fit.ok, JSON.stringify(fit))
      await page.screenshot({ path: join(outDir, 'layout-min-mode-confirm.png') })
    }
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.flowdo.timer.stop(true))
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
