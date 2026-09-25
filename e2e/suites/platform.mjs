/**
 * platform — hotkey probing everywhere; Linux XDG autostart and Windows login-item settings,
 * packaged builds only (unpackaged SKIPs with a reason, since applyLaunchAtLogin no-ops
 * until app.isPackaged — see src/main/index.ts).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { launch, quit, makeProfile, makeReporter, sleep } from '../lib/harness.mjs'

export async function run(ctx = {}) {
  const { check, skip, results } = makeReporter('platform')
  const profile = makeProfile('flowdo-e2e-platform-')
  const packaged = !!ctx.appPath

  let app
  try {
    const launched = await launch({ appPath: ctx.appPath, profile })
    app = launched.app
    const page = launched.page

    // ── Hotkeys: always applicable ────────────────────────────────────────────
    let threw = false
    let probe = null
    try {
      probe = await page.evaluate(() => window.flowdo.system.probeHotkey('Control+Alt+F9'))
    } catch {
      threw = true
    }
    check('probeHotkey does not throw', !threw)
    check(
      'probeHotkey returns free/taken/unavailable',
      ['free', 'taken', 'unavailable'].includes(probe),
      String(probe)
    )

    // ── Linux autostart, packaged only ────────────────────────────────────────
    if (process.platform === 'linux') {
      if (!packaged) {
        skip('Linux launchAtLogin writes the XDG autostart entry', 'unpackaged — applyLaunchAtLogin() no-ops until app.isPackaged')
      } else {
        const xdgConfigHome = profile.xdgConfigHome
        const desktopFile = join(xdgConfigHome, 'autostart', 'flowdo.desktop')

        await page.evaluate(() => window.flowdo.settings.set({ launchAtLogin: true }))
        await sleep(300)
        check('enabling launchAtLogin writes flowdo.desktop', existsSync(desktopFile))

        if (existsSync(desktopFile)) {
          const contents = readFileSync(desktopFile, 'utf-8')
          const execTarget = await app.evaluate(
            ({ app }) => process.env['APPIMAGE'] || process.execPath
          )
          const execLine = contents.split('\n').find((l) => l.startsWith('Exec='))
          check(
            'the .desktop Exec points at the running executable (or $APPIMAGE)',
            !!execLine && execLine.includes(execTarget),
            JSON.stringify({ execLine, execTarget })
          )
        }

        await page.evaluate(() => window.flowdo.settings.set({ launchAtLogin: false }))
        await sleep(300)
        check('disabling launchAtLogin removes flowdo.desktop', !existsSync(desktopFile))
      }
    }

    // ── Windows login item, packaged only ─────────────────────────────────────
    if (process.platform === 'win32') {
      if (!packaged) {
        skip('Windows launchAtLogin toggles the login item', 'unpackaged dev run')
      } else {
        await page.evaluate(() => window.flowdo.settings.set({ launchAtLogin: true }))
        await sleep(300)
        const onSettings = await app.evaluate(({ app }) => app.getLoginItemSettings())
        check('enabling launchAtLogin sets the Windows login item', onSettings.openAtLogin === true, JSON.stringify(onSettings))

        await page.evaluate(() => window.flowdo.settings.set({ launchAtLogin: false }))
        await sleep(300)
        const offSettings = await app.evaluate(({ app }) => app.getLoginItemSettings())
        check('disabling launchAtLogin clears the Windows login item', offSettings.openAtLogin === false, JSON.stringify(offSettings))
      }
    }
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
