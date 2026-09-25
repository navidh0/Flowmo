/**
 * timer — tiny-duration Pomodoro run through start/pause/resume/skip/stop with the session
 * logged correctly, plus a Flowmodoro run showing the earned break and the mode toggle.
 */

import { launch, quit, makeProfile, makeReporter, sleep, waitFor } from '../lib/harness.mjs'

export async function run() {
  const { check, results } = makeReporter('timer')
  const profile = makeProfile('flowdo-e2e-timer-')

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page

    // ── Pomodoro: tiny durations, accepted by the repo's validation ──────────────
    const settings = await page.evaluate(() =>
      window.flowdo.settings.set({
        mode: 'pomodoro',
        pomodoroFocusMs: 3000,
        pomodoroShortBreakMs: 2000,
        pomodoroLongBreakMs: 2000,
        longBreakEvery: 99,
        autoStartBreaks: true,
        autoStartFocus: true
      })
    )
    check(
      'settings.set accepts tiny (3s/2s) durations',
      settings.pomodoroFocusMs === 3000 && settings.pomodoroShortBreakMs === 2000,
      JSON.stringify({ focus: settings.pomodoroFocusMs, short: settings.pomodoroShortBreakMs })
    )

    let state = await page.evaluate(() => window.flowdo.timer.setMode('pomodoro', 'discard'))
    state = await page.evaluate(() => window.flowdo.timer.start())
    check(
      'start() begins a running Pomodoro focus phase',
      state.status === 'running' && state.kind === 'focus' && state.mode === 'pomodoro',
      JSON.stringify(state)
    )

    await page.click('[aria-label="Focus"]')
    await sleep(400)
    const runningVisible = await page.isVisible('button:has-text("Pause")')
    check('running state is visible in the UI (Pause button shown)', runningVisible)

    state = await page.evaluate(() => window.flowdo.timer.pause())
    check('pause() pauses the phase', state.status === 'paused', JSON.stringify(state))

    state = await page.evaluate(() => window.flowdo.timer.resume())
    check('resume() resumes the phase', state.status === 'running', JSON.stringify(state))

    // Auto-start is on for both directions, so the phase after focus is a running break.
    const afterFocus = await waitFor(async () => {
      const s = await page.evaluate(() => window.flowdo.timer.getState())
      return s.kind !== 'focus' ? s : null
    }, 8000)
    check(
      'phase ends and auto-starts the break',
      !!afterFocus && afterFocus.kind === 'short_break' && afterFocus.status === 'running',
      JSON.stringify(afterFocus)
    )

    const recent = await page.evaluate(() => window.flowdo.sessions.recent(3))
    const loggedFocus = recent.find((s) => s.kind === 'focus')
    check(
      'the finished focus phase is logged with the right kind/mode',
      !!loggedFocus && loggedFocus.mode === 'pomodoro' && loggedFocus.completed === true,
      JSON.stringify(loggedFocus)
    )

    // autoStartFocus is on, so skip() must land on a RUNNING focus phase, not merely "not the
    // break anymore" (which would also be true of idle/armed, and those would be a real bug).
    state = await page.evaluate(() => window.flowdo.timer.skip())
    check(
      'skip() advances past the break into a running focus phase',
      state.kind === 'focus' && state.status === 'running',
      JSON.stringify(state)
    )

    state = await page.evaluate(() => window.flowdo.timer.stop())
    check('stop() returns to idle', state.status === 'idle', JSON.stringify(state))

    // ── Flowmodoro: earned break and mode toggle ──────────────────────────────────
    state = await page.evaluate(() => window.flowdo.timer.setMode('flowmodoro', 'discard'))
    state = await page.evaluate(() => window.flowdo.timer.start())
    check(
      'Flowmodoro start() begins an open-ended focus phase',
      state.status === 'running' && state.mode === 'flowmodoro' && state.plannedMs === null,
      JSON.stringify(state)
    )

    await sleep(2200)
    await page.click('[aria-label="Focus"]')
    await sleep(300)
    const earnedVisible = await page.isVisible('text=Break earned')
    check('earned break card shows during Flowmodoro focus', earnedVisible)

    const midState = await page.evaluate(() => window.flowdo.timer.getState())
    check('earned break accrues as focus elapses', (midState.earnedBreakMs ?? 0) > 0, JSON.stringify(midState.earnedBreakMs))

    state = await page.evaluate(() => window.flowdo.timer.stop(true))
    check('Flowmodoro session stops cleanly', state.status === 'idle', JSON.stringify(state))

    // Mode toggle, from idle — no confirmation needed since nothing is active. Currently
    // 'flowmodoro' (set above); click the "Pomodoro" segment and confirm the switch lands.
    await page.click('role=radio[name="Pomodoro"]')
    await sleep(300)
    let toggled = await page.evaluate(() => window.flowdo.timer.getState())
    check('mode toggle switches to Pomodoro via the UI', toggled.mode === 'pomodoro', toggled.mode)

    await page.click('role=radio[name="Flowmodoro"]')
    await sleep(300)
    toggled = await page.evaluate(() => window.flowdo.timer.getState())
    check('mode toggle switches back to Flowmodoro via the UI', toggled.mode === 'flowmodoro', toggled.mode)
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
