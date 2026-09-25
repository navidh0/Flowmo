/**
 * mini — everything e2e/smoke.mjs checked (close-to-tray corner placement, always-on-top,
 * minimize/restore, pin/unpin), plus: a dragged position persists across a restart on the
 * same profile.
 */

import {
  launch,
  quit,
  makeProfile,
  makeReporter,
  getMini,
  getMiniPage,
  getWorkArea,
  onMain,
  outDir,
  sleep,
  waitFor
} from '../lib/harness.mjs'
import { join } from 'node:path'

export async function run(ctx = {}) {
  const { check, skip, results } = makeReporter('mini')
  const checkMinimize = ctx.checkMinimize !== false
  const profile = makeProfile('flowdo-e2e-mini-')

  let app
  try {
    let launched = await launch({ profile })
    app = launched.app
    let page = launched.page
    const workArea = await getWorkArea(app)

    check('no mini widget at start', (await getMini(app)) === null)

    await onMain(app, 'w.close()') // minimizeToTray defaults on: hides, does not quit
    let shown = await waitFor(() => getMini(app))
    check('close-to-tray opens the mini widget', !!shown)

    if (shown) {
      const b = shown.bounds
      const right = workArea.x + workArea.width - (b.x + b.width)
      const bottom = workArea.y + workArea.height - (b.y + b.height)
      check(
        'widget sits in the bottom-right corner',
        right >= 0 && right <= 40 && bottom >= 0 && bottom <= 40,
        JSON.stringify({ right, bottom })
      )
      check('widget is always on top', shown.onTop)
      const miniPage = getMiniPage(app)
      if (miniPage) await miniPage.screenshot({ path: join(outDir, 'mini-widget.png') })
    }

    await onMain(app, 'w.show()')
    check('showing the window closes it again', !!(await waitFor(async () => (await getMini(app)) === null)))

    if (checkMinimize) {
      await onMain(app, 'w.minimize()')
      check('minimize opens the mini widget', !!(await waitFor(() => getMini(app))))
      await onMain(app, 'w.restore()')
      check('restore closes it again', !!(await waitFor(async () => (await getMini(app)) === null)))

      await onMain(app, 'w.minimize()')
      await waitFor(() => getMini(app))
      await page.evaluate(() => window.flowdo.settings.set({ showMiniWidget: true }))
      await onMain(app, 'w.restore()')
      await sleep(800)
      check('a widget pinned while auto-shown stays after restore', (await getMini(app)) !== null)
      await page.evaluate(() => window.flowdo.settings.set({ showMiniWidget: false }))
      check('unpinning closes it', !!(await waitFor(async () => (await getMini(app)) === null)))
    } else {
      skip('minimize checks', '--no-minimize')
    }

    await page.evaluate(() => window.flowdo.settings.set({ miniWidgetOnMinimize: false }))
    await onMain(app, 'w.hide()')
    await sleep(1000)
    check('with the option off, leaving opens nothing', (await getMini(app)) === null)
    await onMain(app, 'w.show()')
    await page.evaluate(() => window.flowdo.settings.set({ miniWidgetOnMinimize: true }))

    // ── Dragged position persists across a restart ────────────────────────────
    await onMain(app, 'w.close()')
    shown = await waitFor(() => getMini(app))
    check('mini widget reopened to drag it', !!shown)

    const dragged = { x: workArea.x + 24, y: workArea.y + 24 }
    await app.evaluate(
      ({ BrowserWindow }, pos) => {
        // Same destroyed-window race as harness.mjs's windowsInfo/onMain: filter alive
        // windows before touching webContents, all inside this one synchronous callback.
        const w = BrowserWindow.getAllWindows()
          .filter((x) => !x.isDestroyed() && !x.webContents.isDestroyed())
          .find((x) => x.webContents.getURL().includes('mini'))
        w?.setPosition(pos.x, pos.y)
      },
      dragged
    )
    await sleep(700) // past the 400ms debounce in index.ts's rememberMiniPosition

    // ── Resizing: the countdown grows with the widget, and the size is remembered ──
    const countdownPx = async () => {
      const miniPage = getMiniPage(app)
      if (!miniPage) return null
      // The countdown is the one element sized by a clamp() font size (MiniWidget.tsx).
      return miniPage.evaluate(() => {
        const el = [...document.querySelectorAll('div')].find((d) => /^\d{1,2}(:\d\d){1,2}$/.test(d.textContent?.trim() ?? '') && d.children.length === 0)
        return el ? parseFloat(getComputedStyle(el).fontSize) : null
      })
    }
    const setMiniSize = (size) =>
      app.evaluate(({ BrowserWindow }, s) => {
        const w = BrowserWindow.getAllWindows()
          .filter((x) => !x.isDestroyed() && !x.webContents.isDestroyed())
          .find((x) => x.webContents.getURL().includes('mini'))
        w?.setSize(s.width, s.height)
      }, size)

    const smallFont = await countdownPx()
    const small = getMiniPage(app)
    if (small) await small.screenshot({ path: join(outDir, 'mini-220x88.png') })

    const resized = { width: 360, height: 150 }
    await setMiniSize(resized)
    await sleep(700) // past the 400ms debounce in index.ts's rememberMiniSize
    const grown = await getMini(app)
    check(
      'mini widget resizes',
      !!grown && grown.bounds.width === resized.width && grown.bounds.height === resized.height,
      JSON.stringify(grown?.bounds)
    )
    const bigFont = await countdownPx()
    check(
      'the countdown grows with the widget',
      smallFont != null && bigFont != null && bigFont > smallFont,
      JSON.stringify({ at220x88: smallFont, at360x150: bigFont })
    )
    const big = getMiniPage(app)
    if (big) await big.screenshot({ path: join(outDir, 'mini-360x150.png') })

    await quit(app)

    launched = await launch({ profile })
    app = launched.app
    page = launched.page

    await onMain(app, 'w.close()')
    const afterRestart = await waitFor(() => getMini(app))
    check(
      'dragged mini position persists across a restart',
      !!afterRestart &&
        Math.abs(afterRestart.bounds.x - dragged.x) <= 2 &&
        Math.abs(afterRestart.bounds.y - dragged.y) <= 2,
      JSON.stringify({ dragged, got: afterRestart?.bounds })
    )
    check(
      'resized mini size persists across a restart',
      !!afterRestart &&
        afterRestart.bounds.width === resized.width &&
        afterRestart.bounds.height === resized.height,
      JSON.stringify({ resized, got: afterRestart?.bounds })
    )

    await setMiniSize({ width: 900, height: 600 })
    await sleep(300)
    const capped = await getMini(app)
    check(
      'the widget cannot grow past its maximum',
      !!capped && capped.bounds.width <= 480 && capped.bounds.height <= 200,
      JSON.stringify(capped?.bounds)
    )
    const maxPage = getMiniPage(app)
    if (maxPage) await maxPage.screenshot({ path: join(outDir, 'mini-max.png') })
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
