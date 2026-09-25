/**
 * calendar — Day/Week/Month render, the Week and Month headers start on the configured first
 * day of the week (Sunday, then back to Monday), and a logged session shows up in Day view.
 */

import { launch, quit, makeProfile, makeReporter, sleep } from '../lib/harness.mjs'

export async function run() {
  const { check, results } = makeReporter('calendar')
  const profile = makeProfile('flowdo-e2e-calendar-')

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page

    // Seed one real logged session (Flowmodoro focus always logs as completed on stop()).
    await page.evaluate(() => window.flowdo.timer.setMode('flowmodoro', 'discard'))
    await page.evaluate(() => window.flowdo.timer.start())
    await sleep(1500)
    await page.evaluate(() => window.flowdo.timer.stop())
    // Check the actual session row landed in the DB, not just that the timer went idle
    // (idle alone would also be true of a discarded/never-logged session).
    //
    // KNOWN APP DISCREPANCY (not weakened away — see the run report): src/shared/types.ts's
    // `PhaseEndEvent.completed` doc says "Flowmodoro focus: always true (the user chose to
    // stop)", and `skip()`/`takeBreak()` in src/main/timer.ts implement exactly that. But
    // `stop()` in the same file unconditionally passes `completed: false`, so a Flowmodoro
    // focus session ended via Stop (as here) persists `completed: false` — which then renders
    // as "stopped early"/dashed in the calendar and Stats history, and is excluded from
    // `avgFocusMs`, even though nothing was abandoned. This check asserts the DOCUMENTED
    // contract and is therefore expected to FAIL until that's resolved one way or the other.
    const seeded = await page.evaluate(() => window.flowdo.sessions.recent(1))
    check(
      'a completed focus session was actually logged to seed the calendar',
      seeded.length === 1 && seeded[0].kind === 'focus' && seeded[0].mode === 'flowmodoro' && seeded[0].completed === true,
      JSON.stringify(seeded[0] ?? null)
    )

    await page.click('[aria-label="Calendar"]')
    await sleep(500)

    // ── Day view renders ───────────────────────────────────────────────────────
    const dayChecked = await page.getAttribute('role=radio[name="Day"]', 'aria-checked')
    check('Day view is the default and renders', dayChecked === 'true')
    const dayBlockVisible = await page.isVisible('[aria-label^="Focus"]')
    check('the seeded session appears as a block in Day view', dayBlockVisible)

    // ── weekStartsOn = 0 (Sunday) ──────────────────────────────────────────────
    await page.evaluate(() => window.flowdo.settings.set({ weekStartsOn: 0 }))
    await page.click('role=radio[name="Week"]')
    await sleep(700)

    const sunday = await page.evaluate(() =>
      new Date(2026, 0, 4).toLocaleDateString(undefined, { weekday: 'short' })
    )
    const monday = await page.evaluate(() =>
      new Date(2026, 0, 5).toLocaleDateString(undefined, { weekday: 'short' })
    )

    const weekHeading = await page.textContent('h1')
    check(
      'Week heading starts on Sunday after weekStartsOn = 0',
      (weekHeading ?? '').trim().startsWith(sunday),
      weekHeading ?? ''
    )

    await page.click('role=radio[name="Month"]')
    await sleep(700)
    const monthLabels = await page.$$eval(
      '.grid.grid-cols-7.border-b > div',
      (divs) => divs.map((d) => d.textContent?.trim())
    )
    check(
      'Month header row starts on Sunday',
      monthLabels[0] === sunday,
      JSON.stringify(monthLabels)
    )

    // ── back to Monday ─────────────────────────────────────────────────────────
    await page.evaluate(() => window.flowdo.settings.set({ weekStartsOn: 1 }))
    await sleep(700)
    const monthLabelsMonday = await page.$$eval(
      '.grid.grid-cols-7.border-b > div',
      (divs) => divs.map((d) => d.textContent?.trim())
    )
    check(
      'Month header row goes back to starting on Monday',
      monthLabelsMonday[0] === monday,
      JSON.stringify(monthLabelsMonday)
    )
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
