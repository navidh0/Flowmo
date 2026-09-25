/**
 * settings-persistence — several settings changed through the UI, plus window bounds moved
 * through the main process, both survive a restart on the SAME throwaway profile.
 */

import { launch, quit, makeProfile, makeReporter, onMain, sleep, windowsInfo } from '../lib/harness.mjs'

async function selectValue(page, labelText, value) {
  const select = page.locator(`label:has-text("${labelText}") select`).first()
  await select.selectOption(value)
}

async function toggle(page, labelText) {
  const checkbox = page.locator(`label:has-text("${labelText}") input[type="checkbox"]`).first()
  await checkbox.click()
}

async function toggleChecked(page, labelText) {
  const checkbox = page.locator(`label:has-text("${labelText}") input[type="checkbox"]`).first()
  return checkbox.isChecked()
}

export async function run() {
  const { check, results } = makeReporter('settings-persistence')
  const profile = makeProfile('flowdo-e2e-settings-')

  let app
  try {
    let launched = await launch({ profile })
    app = launched.app
    let page = launched.page

    await page.click('[aria-label="Settings"]')
    await sleep(500)

    const before = await page.evaluate(() => window.flowdo.settings.get())

    // theme
    const nextTheme = before.theme === 'dark' ? 'light' : 'dark'
    await selectValue(page, 'Theme', nextTheme)
    // weekStartsOn
    const nextWeekStartsOn = before.weekStartsOn === 0 ? 3 : 0
    await selectValue(page, 'First day of the week', String(nextWeekStartsOn))
    // a duration
    const durationInput = page.locator('label:has-text("Focus length") input').first()
    await durationInput.fill('37')
    await durationInput.blur()
    await sleep(200)
    // miniWidgetOnMinimize
    const miniBefore = await toggleChecked(page, 'Mini widget when minimized')
    await toggle(page, 'Mini widget when minimized')
    // autoUpdate
    const autoUpdateBefore = await toggleChecked(page, 'Update automatically')
    await toggle(page, 'Update automatically')

    await sleep(400)
    const afterSet = await page.evaluate(() => window.flowdo.settings.get())
    check(
      'settings changed through the UI are applied',
      afterSet.theme === nextTheme &&
        afterSet.weekStartsOn === nextWeekStartsOn &&
        afterSet.pomodoroFocusMs === 37 * 60_000 &&
        afterSet.miniWidgetOnMinimize === !miniBefore &&
        afterSet.autoUpdate === !autoUpdateBefore,
      JSON.stringify(afterSet)
    )

    // Move the window before restarting, to check bounds persistence too.
    await onMain(app, 'w.setBounds({ x: 60, y: 70, width: 900, height: 640 })')
    await sleep(700)

    await quit(app)

    launched = await launch({ profile })
    app = launched.app
    page = launched.page

    await page.click('[aria-label="Settings"]')
    await sleep(500)

    const afterRestart = await page.evaluate(() => window.flowdo.settings.get())
    check(
      'settings persist across a restart on the same profile',
      afterRestart.theme === nextTheme &&
        afterRestart.weekStartsOn === nextWeekStartsOn &&
        afterRestart.pomodoroFocusMs === 37 * 60_000 &&
        afterRestart.miniWidgetOnMinimize === !miniBefore &&
        afterRestart.autoUpdate === !autoUpdateBefore,
      JSON.stringify(afterRestart)
    )

    const themeSelectValue = await page.locator('label:has-text("Theme") select').first().inputValue()
    check('theme select reflects the persisted value in the UI', themeSelectValue === nextTheme, themeSelectValue)

    const durationValue = await page.locator('label:has-text("Focus length") input').first().inputValue()
    check('duration field reflects the persisted value in the UI', durationValue === '37', durationValue)

    const bounds = (await windowsInfo(app)).find((w) => !w.mini)?.bounds
    check(
      'window bounds persist across restart',
      !!bounds && bounds.x === 60 && bounds.y === 70 && bounds.width === 900 && bounds.height === 640,
      JSON.stringify(bounds)
    )
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
