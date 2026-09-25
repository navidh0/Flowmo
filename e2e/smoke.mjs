/**
 * End-to-end smoke test: drives the BUILT app (`npm run build` first) through the checks a
 * release must pass and that no unit test can reach — real windows, real IPC, real SQLite.
 *
 * Always runs against a throwaway profile via FLOWDO_USER_DATA_DIR, never real data: the
 * 2026-09-24 WAL incident followed two builds sharing one profile. Screenshots land in
 * e2e/out/ (gitignored) and are uploaded by CI.
 *
 * Minimize needs a window manager, which Windows always has and Xvfb does not; pass
 * --no-minimize where there is none (the close-to-tray path is checked either way).
 *
 * Usage: node e2e/smoke.mjs [--no-minimize]
 */

import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'e2e', 'out')
const checkMinimize = !process.argv.includes('--no-minimize')
const require = createRequire(import.meta.url)
const electronPath = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const consoleErrors = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/** Poll `fn` until it returns truthy or `ms` elapses; returns the last value. */
async function waitFor(fn, ms = 4000) {
  const deadline = Date.now() + ms
  let value = await fn()
  while (!value && Date.now() < deadline) {
    await sleep(150)
    value = await fn()
  }
  return value
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'flowdo-e2e-'))

  const app = await electron.launch({
    executablePath: electronPath,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), root],
    env: { ...process.env, FLOWDO_USER_DATA_DIR: profile }
  })

  try {
    const main = await app.firstWindow()
    main.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
    await main.waitForLoadState('domcontentloaded')
    await sleep(1500)

    // ── The profile really is the throwaway one ────────────────────────────────
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    check('runs against the throwaway profile', resolve(userData) === resolve(profile), userData)

    // Main-process helpers. Windows are told apart by the mini widget's #/mini route.
    //
    // The mini widget opens/closes on a timer main owns, so a window can be mid-teardown —
    // still in getAllWindows(), but its webContents already destroyed — at the exact moment
    // one of these runs; touching it then throws "Object has been destroyed". The alive
    // check and the field reads/find() it guards are one synchronous expression inside one
    // evaluate() call each, so nothing can destroy a window BETWEEN the check and the touch —
    // only a window already destroyed when the callback starts can slip through, and the
    // filter excludes exactly that one.
    const windows = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
          .map((w) => ({
            mini: w.webContents.getURL().includes('mini'),
            visible: w.isVisible(),
            minimized: w.isMinimized(),
            bounds: w.getBounds(),
            onTop: w.isAlwaysOnTop()
          }))
      )
    const mini = async () => (await windows()).find((w) => w.mini && w.visible) ?? null
    const onMain = (fn) =>
      app.evaluate(({ BrowserWindow }, body) => {
        const w = BrowserWindow.getAllWindows()
          .filter((x) => !x.isDestroyed() && !x.webContents.isDestroyed())
          .find((x) => !x.webContents.getURL().includes('mini'))
        // eslint-disable-next-line no-new-func
        new Function('w', body)(w)
      }, fn)
    const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)

    // ── Updates: a test profile never self-updates, and says so ────────────────
    const update = await main.evaluate(() => window.flowdo.updates.getStatus())
    check(
      'updater reports unsupported on a test profile',
      update.state === 'unsupported' && update.reason === 'test-profile',
      JSON.stringify(update)
    )

    // ── Settings: first day of the week reaches the calendar ───────────────────
    await main.evaluate(() => window.flowdo.settings.set({ weekStartsOn: 0 }))
    await main.click('[aria-label="Calendar"]')
    await main.click('role=radio[name="Week"]')
    await sleep(800)
    const firstColumn = await main.evaluate(() => {
      const sunday = new Date(2026, 0, 4).toLocaleDateString(undefined, { weekday: 'short' })
      const heading = document.querySelector('h1')?.textContent ?? ''
      return { sunday, heading }
    })
    check(
      'Week heading starts on Sunday after weekStartsOn = 0',
      firstColumn.heading.startsWith(firstColumn.sunday),
      firstColumn.heading
    )
    await main.screenshot({ path: join(outDir, 'week-sunday.png') })
    await main.evaluate(() => window.flowdo.settings.set({ weekStartsOn: 1 }))

    // ── Mini widget: close to tray ─────────────────────────────────────────────
    check('no mini widget at start', (await mini()) === null)
    await onMain('w.close()') // minimizeToTray is on by default: hides, does not quit
    const shown = await waitFor(mini)
    check('close-to-tray opens the mini widget', !!shown)
    if (shown) {
      const b = shown.bounds
      const right = workArea.x + workArea.width - (b.x + b.width)
      const bottom = workArea.y + workArea.height - (b.y + b.height)
      check('widget sits in the bottom-right corner', right >= 0 && right <= 40 && bottom >= 0 && bottom <= 40, JSON.stringify({ right, bottom }))
      check('widget is always on top', shown.onTop)
      const miniPage = app.windows().find((p) => p.url().includes('mini'))
      if (miniPage) await miniPage.screenshot({ path: join(outDir, 'mini-widget.png') })
    }
    await onMain('w.show()')
    check('showing the window closes it again', !!(await waitFor(async () => (await mini()) === null)))

    // ── Mini widget: minimize (needs a window manager) ─────────────────────────
    if (checkMinimize) {
      await onMain('w.minimize()')
      check('minimize opens the mini widget', !!(await waitFor(mini)))
      await onMain('w.restore()')
      check('restore closes it again', !!(await waitFor(async () => (await mini()) === null)))

      // Pinned while auto-shown: it stays.
      await onMain('w.minimize()')
      await waitFor(mini)
      await main.evaluate(() => window.flowdo.settings.set({ showMiniWidget: true }))
      await onMain('w.restore()')
      await sleep(800)
      check('a widget pinned while auto-shown stays after restore', (await mini()) !== null)
      await main.evaluate(() => window.flowdo.settings.set({ showMiniWidget: false }))
      check('unpinning closes it', !!(await waitFor(async () => (await mini()) === null)))
    } else {
      console.log('SKIP  minimize checks (--no-minimize)')
    }

    // ── Option off: nothing appears ────────────────────────────────────────────
    await main.evaluate(() => window.flowdo.settings.set({ miniWidgetOnMinimize: false }))
    await onMain('w.hide()')
    await sleep(1000)
    check('with the option off, leaving opens nothing', (await mini()) === null)
    await onMain('w.show()')

    await main.screenshot({ path: join(outDir, 'final.png') })
    check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '))
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true })
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log('\nAll smoke checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
