/**
 * shell — the app launches, runs against the throwaway profile, every nav screen renders
 * with no console errors, the window title is right, and the reported version matches
 * package.json.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launch, quit, makeProfile, makeReporter, sleep, root } from '../lib/harness.mjs'

// Each screen's own content selector, not just the nav button's `aria-current` — a nav
// button can go active while the panel next to it stays blank (a broken lazy import, for
// instance), and that must show up as a failure here, not as a false PASS.
// The timer column (ModeToggle etc.) is pinned on EVERY screen (see App.tsx), so it cannot
// tell one screen's content apart from another's — each selector below instead comes from
// the "main"/"projects" panel, which really does swap per screen.
const SCREENS = [
  { label: 'Focus', aria: 'Focus', content: '[aria-label="New project"]' },
  { label: 'Calendar', aria: 'Calendar', content: '[role="radiogroup"][aria-label="Timeline view"]' },
  { label: 'Stats', aria: 'Stats', content: 'h1:has-text("Stats")' },
  { label: 'Settings', aria: 'Settings', content: 'h1:has-text("Settings")' }
]

export async function run() {
  const { check, results } = makeReporter('shell')
  const profile = makeProfile('flowdo-e2e-shell-')

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page
    const consoleErrors = launched.consoleErrors

    // Not just "a window exists" (playwright's own launch() would have thrown before we got
    // here otherwise) — the real Focus-screen chrome must actually be painted.
    const navRendered = await page.isVisible('[aria-label="Main navigation"]')
    const dialRendered = await page.isVisible('text=Start focus')
    check('app launches and renders the Focus screen', navRendered && dialRendered)

    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    check(
      'runs against the throwaway profile',
      resolve(userData) === resolve(profile.userDataDir),
      userData
    )

    const title = await page.title()
    check('window title is Flowdo', title === 'Flowdo', title)

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
    const version = await page.evaluate(() => window.flowdo.app.getVersion())
    check('app.getVersion() matches package.json', version === pkg.version, `${version} vs ${pkg.version}`)

    for (const { label, aria, content } of SCREENS) {
      await page.click(`[aria-label="${aria}"]`)
      await sleep(400)
      const navActive = await page.isVisible(`[aria-label="${aria}"][aria-current="page"]`)
      const contentVisible = await page.isVisible(content)
      check(`${label} screen navigates and renders`, navActive && contentVisible, `nav active: ${navActive}, content visible: ${contentVisible}`)
    }

    // Back to Focus so nothing lingers on a lazy-loaded screen.
    await page.click('[aria-label="Focus"]')
    await sleep(300)

    check('no console errors across every screen', consoleErrors.length === 0, consoleErrors.join(' | '))
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
