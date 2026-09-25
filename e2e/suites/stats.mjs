/**
 * stats — after sessions exist, the summary and history reflect them, and deleting one from
 * history lowers the total. Session durations here are seconds (not minutes, for runtime's
 * sake), so the numeric assertions go through the API (`stats.summary`) where the real
 * millisecond totals live; the UI assertions check that the screen is wired to that same
 * data (session counts, weekday-dated history rows), which `formatDuration`'s minute
 * rounding would otherwise mask.
 */

import { launch, quit, makeProfile, makeReporter, sleep } from '../lib/harness.mjs'

export async function run() {
  const { check, results } = makeReporter('stats')
  const profile = makeProfile('flowdo-e2e-stats-')

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page

    // Two short logged focus sessions.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.flowdo.timer.setMode('flowmodoro', 'discard'))
      await page.evaluate(() => window.flowdo.timer.start())
      await sleep(1200)
      await page.evaluate(() => window.flowdo.timer.stop())
    }

    const summaryBefore = await page.evaluate(() => window.flowdo.stats.summary('week'))
    check(
      'stats.summary reports exactly the 2 seeded focus sessions',
      summaryBefore.focusMs > 0 && summaryBefore.focusSessions === 2,
      JSON.stringify(summaryBefore)
    )

    await page.click('[aria-label="Stats"]')
    await sleep(600)

    const focusHint = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('div.rounded-xl'))
      for (const card of cards) {
        if (card.children[0]?.textContent?.trim() === 'Focus time') {
          return card.children[2]?.textContent?.trim() ?? null
        }
      }
      return null
    })
    check(
      'Stats screen shows the real session count for the seeded sessions',
      !!focusHint && new RegExp(`^${summaryBefore.focusSessions} session`).test(focusHint),
      focusHint ?? '(not found)'
    )

    // Scoped to the history list itself, not `document.body` as a whole — the always-mounted
    // timer dial also renders a `00:00`-shaped string, which would satisfy a bare time regex
    // regardless of whether any history row actually rendered.
    const historyRowCount = await page.locator('button[aria-label="Delete session"]').count()
    check(
      'history lists exactly the 2 seeded sessions, each with a delete control',
      historyRowCount === 2,
      `${historyRowCount} row(s)`
    )

    // sessionsRepo.recent() orders `started_at DESC, id DESC` — the same order
    // SessionHistory.tsx renders `history` in — so the FIRST row in the DOM is always
    // recentBefore[0]; clicking the first "Delete session" button deletes exactly that row.
    const recentBefore = await page.evaluate(() => window.flowdo.sessions.recent(10))
    const toDelete = recentBefore[0]
    check(
      'the session about to be deleted is one of the two seeded focus sessions',
      !!toDelete && toDelete.kind === 'focus' && toDelete.mode === 'flowmodoro' && toDelete.actualMs > 0,
      JSON.stringify(toDelete)
    )

    if (toDelete) {
      const deleteButtons = page.locator('button[aria-label="Delete session"]')
      await deleteButtons.first().hover()
      await deleteButtons.first().click()
      await sleep(600)

      const summaryAfter = await page.evaluate(() => window.flowdo.stats.summary('week'))
      const expectedSessions = summaryBefore.focusSessions - 1
      const expectedFocusMs = summaryBefore.focusMs - toDelete.actualMs
      check(
        'deleting the focus session lowers focusSessions by exactly 1 and focusMs by exactly its actualMs',
        summaryAfter.focusSessions === expectedSessions && summaryAfter.focusMs === expectedFocusMs,
        JSON.stringify({ before: summaryBefore, after: summaryAfter, deletedActualMs: toDelete.actualMs })
      )

      const hintAfter = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('div.rounded-xl'))
        for (const card of cards) {
          if (card.children[0]?.textContent?.trim() === 'Focus time') {
            return card.children[2]?.textContent?.trim() ?? null
          }
        }
        return null
      })
      const expectedHint = `${expectedSessions} session${expectedSessions === 1 ? '' : 's'}, incl. abandoned`
      check(
        'the Focus time card\'s session count re-renders to the new total after the delete',
        hintAfter === expectedHint,
        `got ${JSON.stringify(hintAfter)}, expected ${JSON.stringify(expectedHint)}`
      )
    }
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
