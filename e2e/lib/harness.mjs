/**
 * Shared launch/attach/teardown plumbing for every e2e suite.
 *
 * Every launch uses a fresh throwaway profile (`FLOWDO_USER_DATA_DIR`) and a fresh
 * `XDG_CONFIG_HOME` (so the Linux autostart `.desktop` file never touches the real
 * `~/.config/autostart`), never real user data — see e2e/smoke.mjs's header for the WAL
 * incident this guards against. A "restart" reuses the SAME profile dirs; a fresh scenario
 * calls `makeProfile()` again.
 */

import { _electron as electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const outDir = join(root, 'e2e', 'out')
mkdirSync(outDir, { recursive: true })

const require = createRequire(import.meta.url)
export const electronPath = require('electron')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll `fn` until it returns truthy or `ms` elapses; returns the last value. */
export async function waitFor(fn, ms = 4000) {
  const deadline = Date.now() + ms
  let value = await fn()
  while (!value && Date.now() < deadline) {
    await sleep(150)
    value = await fn()
  }
  return value
}

/** A fresh throwaway profile: userData dir + an isolated XDG_CONFIG_HOME. */
export function makeProfile(prefix = 'flowdo-e2e-') {
  const userDataDir = mkdtempSync(join(tmpdir(), prefix))
  const xdgConfigHome = mkdtempSync(join(tmpdir(), `${prefix}xdg-`))
  return {
    userDataDir,
    xdgConfigHome,
    env() {
      return { FLOWDO_USER_DATA_DIR: userDataDir, XDG_CONFIG_HOME: xdgConfigHome }
    },
    cleanup() {
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(xdgConfigHome, { recursive: true, force: true })
    }
  }
}

/**
 * Launch either the unpackaged build (no `appPath`: `electron .` against `root`, exactly
 * what e2e/smoke.mjs does) or a packaged executable (`appPath`: a real .exe/AppImage-extract/
 * deb-extract binary, run standalone with no root arg).
 *
 * Returns `{ app, page, consoleErrors }`; `page` is the main (non-mini) window, already past
 * `domcontentloaded`. Packaged Linux Electron run as root needs `--no-sandbox`, same as dev.
 */
export async function launch({ appPath, profile, extraArgs = [], extraEnv = {} } = {}) {
  const isLinux = process.platform === 'linux'
  const executablePath = appPath ?? electronPath
  const args = appPath
    ? [...(isLinux ? ['--no-sandbox'] : []), ...extraArgs]
    : [...(isLinux ? ['--no-sandbox'] : []), root, ...extraArgs]

  const app = await electron.launch({
    executablePath,
    args,
    env: { ...process.env, ...profile.env(), ...extraEnv }
  })

  const consoleErrors = []
  const page = await app.firstWindow()
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  await page.waitForLoadState('domcontentloaded')
  await sleep(1500)

  return { app, page, consoleErrors }
}

/** Quit cleanly via `app.quit()` from the main process — never kill -9 mid-write. */
export async function quit(app) {
  await app.evaluate(({ app }) => app.quit()).catch(() => {})
  await app.close().catch(() => {})
}

/** Every open BrowserWindow's shape, main and mini told apart by the mini route. */
export function windowsInfo(app) {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      mini: w.webContents.getURL().includes('mini'),
      visible: w.isVisible(),
      minimized: w.isMinimized(),
      bounds: w.getBounds(),
      onTop: w.isAlwaysOnTop()
    }))
  )
}

export async function getMini(app) {
  return (await windowsInfo(app)).find((w) => w.mini && w.visible) ?? null
}

/** Run `fnBody` (a function body string, receiving `w`) against the main (non-mini) window. */
export function onMain(app, fnBody) {
  return app.evaluate(({ BrowserWindow }, body) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('mini'))
    // eslint-disable-next-line no-new-func
    new Function('w', body)(w)
  }, fnBody)
}

export function getMiniPage(app) {
  return app.windows().find((p) => p.url().includes('mini')) ?? null
}

export async function getWorkArea(app) {
  return app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
}

/** A suite's console reporter: prints `STATUS  suite › check — detail` as it goes. */
export function makeReporter(suiteName) {
  const results = []
  function record(status, name, detail) {
    console.log(`${status}  ${suiteName} › ${name}${detail ? ` — ${detail}` : ''}`)
    results.push({ suite: suiteName, name, status, detail })
  }
  return {
    check(name, ok, detail = '') {
      record(ok ? 'PASS' : 'FAIL', name, detail)
    },
    skip(name, detail = '') {
      record('SKIP', name, detail)
    },
    results
  }
}
