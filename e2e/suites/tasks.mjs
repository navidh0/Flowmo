/**
 * tasks — project/task/subtask CRUD, driven end-to-end through the UI.
 *
 * Deliberately NOT seeded through the raw `window.flowdo.tasks.create()` API here: the tasks
 * store only refreshes on ITS OWN mutations (`stores/tasks.ts`), and `TaskChip` keeps the
 * store's ref-counted bootstrap alive on every screen (it lives in the always-mounted
 * `TimerPanel`), so nothing short of the store's own actions — i.e. driving the real UI —
 * would ever make freshly-seeded rows appear. That makes the UI the only reliable path here,
 * which is also exactly what this suite is meant to exercise.
 */

import { launch, quit, makeProfile, makeReporter, onMain, sleep } from '../lib/harness.mjs'

/** Clicks the "Today"/"Tomorrow"/"Clear" quick button inside the task detail panel's "Due
 *  date" field — scoped by DOM structure since both the sidebar and the calendar header
 *  also have buttons with the same text. */
async function clickDueDateQuickButton(page, label) {
  return page.evaluate((lbl) => {
    const leaves = Array.from(document.querySelectorAll('div')).filter(
      (d) => d.children.length === 0 && d.textContent?.trim() === 'Due date'
    )
    for (const leaf of leaves) {
      const fieldWrapper = leaf.parentElement?.parentElement
      if (!fieldWrapper) continue
      const btn = Array.from(fieldWrapper.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === lbl
      )
      if (btn) {
        btn.click()
        return true
      }
    }
    return false
  }, label)
}

/** Selects a task row by title, scrolling it into view first, in case the row is merely
 *  scrolled out of the list's own `overflow-y-auto`, not squeezed to zero width. */
async function clickTaskRow(page, title) {
  const row = page.locator(`button[data-task-row]:has-text("${title}")`)
  await row.scrollIntoViewIfNeeded()
  await row.click()
}

/** The real (non-mini) window's minimum size, `[width, height]` — same window `onMain`
 *  targets, via the harness's own alive-window filter. */
async function getMainMinimumSize(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()
      .filter((x) => !x.isDestroyed() && !x.webContents.isDestroyed())
      .find((x) => !x.webContents.getURL().includes('mini'))
    return w ? w.getMinimumSize() : null
  })
}

/**
 * Selecting a task must never make the list unreachable — the bug this suite exists to
 * catch: at a narrow 'main' panel (PANEL_MIN_WIDTH.main = 280, src/shared/types.ts, can be
 * narrower than the task detail panel's 19rem), the list either stays visible beside the
 * detail, or the detail opens as an overlay whose close control returns to a visible, still
 * clickable list — either way, real geometry (`boundingBox().width > 0`, `isVisible()`),
 * never just DOM presence.
 */
async function checkDetailAndListReachable(page, check, title, sizeLabel) {
  await clickTaskRow(page, title)
  await sleep(300)

  const titleField = page.locator('[aria-label="Task title"]')
  const detailVisible = await titleField.isVisible().catch(() => false)
  const detailBox = detailVisible ? await titleField.boundingBox() : null
  check(
    `[${sizeLabel}] selecting "${title}" shows the detail panel`,
    detailVisible && !!detailBox && detailBox.width > 0,
    JSON.stringify({ detailVisible, detailBox })
  )

  const shownTitle = detailVisible ? await titleField.inputValue() : null
  check(
    `[${sizeLabel}] detail shows the selected task's title`,
    shownTitle === title,
    `detail title field: ${JSON.stringify(shownTitle)}`
  )

  const rowLocator = page.locator(`button[data-task-row]:has-text("${title}")`)
  const rowVisibleWhileOpen = await rowLocator.isVisible().catch(() => false)

  // If the row isn't visible side by side, the ONLY acceptable reason is a genuine
  // full-panel overlay (real geometry, not just DOM presence): the detail's outer box must
  // actually match the panel's own box, not merely a fixed-width sliver that happens to have
  // squeezed the list to nothing — which is exactly the bug this suite exists to catch. A
  // fixed-width sliver overflowing a too-narrow container would NOT match this (it is
  // usually wider than the container, or offset from its left edge by whatever the squeezed
  // list left behind).
  // Scoped inside the panel root: `<aside>` alone would also match the (unrelated) project
  // sidebar's own `<aside>` in the shell's other column.
  const panelBox = await page.locator('[data-tasks-panel-root]').boundingBox()
  const asideBox = await page.locator('[data-tasks-panel-root] aside').first().boundingBox()
  const genuineOverlay =
    !!panelBox &&
    !!asideBox &&
    Math.abs(asideBox.width - panelBox.width) <= 4 &&
    Math.abs(asideBox.x - panelBox.x) <= 4
  check(
    `[${sizeLabel}] the list is visible side by side, or the detail is a genuine full-panel overlay`,
    rowVisibleWhileOpen || genuineOverlay,
    JSON.stringify({ rowVisibleWhileOpen, panelBox, asideBox })
  )

  await page.click('[aria-label="Close details"]')
  await sleep(300)

  const rowVisibleAfterClose = await rowLocator.isVisible().catch(() => false)
  const rowBoxAfterClose = rowVisibleAfterClose ? await rowLocator.boundingBox() : null
  check(
    `[${sizeLabel}] closing the detail returns to a visible task list`,
    rowVisibleAfterClose && !!rowBoxAfterClose && rowBoxAfterClose.width > 0,
    JSON.stringify({ rowVisibleAfterClose, rowBoxAfterClose })
  )

  // Prove the row is clickable again, not merely painted — reopen and close once more.
  await clickTaskRow(page, title)
  await sleep(300)
  const reopened = await page.locator('[aria-label="Task title"]').isVisible().catch(() => false)
  check(`[${sizeLabel}] the row is clickable again after closing the detail`, reopened)
  await page.click('[aria-label="Close details"]')
  await sleep(200)
}

export async function run() {
  const { check, skip, results } = makeReporter('tasks')
  const profile = makeProfile('flowdo-e2e-tasks-')

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page

    // Deliberately the app's own default window size (1040×720, src/main/windows.ts) — not
    // resized up front. The task detail panel now responds to its OWN width (a `@container`
    // query in src/renderer/src/components/tasks/index.tsx) rather than assuming the 'main'
    // shell panel around it is always wide enough, so this suite runs at the size real users
    // (and Windows CI) actually see instead of dodging the case where it isn't.
    await page.click('[aria-label="Focus"]')
    await sleep(400)

    const { todayKey, tomorrowKey } = await page.evaluate(() => {
      const pad = (n) => String(n).padStart(2, '0')
      const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const today = new Date()
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      return { todayKey: key(today), tomorrowKey: key(tomorrow) }
    })

    // ── Project ────────────────────────────────────────────────────────────────
    await page.click('[aria-label="New project"]')
    await page.fill('[aria-label="New project name"]', 'E2E Project')
    await page.press('[aria-label="New project name"]', 'Enter')
    await sleep(500)
    const projectVisible = await page.isVisible('text=E2E Project')
    check('project created via the UI', projectVisible)

    // ── Tasks + due dates ──────────────────────────────────────────────────────
    async function addTask(title) {
      await page.fill('[aria-label="Add a task"]', title)
      await page.press('[aria-label="Add a task"]', 'Enter')
      await sleep(400)
    }
    await addTask('Task due today')
    await addTask('Task due tomorrow')
    await addTask('Task to delete')

    // ── Detail panel stays reachable at any panel width ───────────────────────────
    await checkDetailAndListReachable(page, check, 'Task due today', 'default window size')

    const minSize = await getMainMinimumSize(app)
    if (minSize) {
      await onMain(app, `w.setSize(${minSize[0]}, ${minSize[1]})`)
      await sleep(400)
      await checkDetailAndListReachable(page, check, 'Task due today', 'minimum window width')
      // Back to the default so the rest of the suite (due-date buttons, etc.) has its usual room.
      await onMain(app, 'w.setSize(1040, 720)')
      await sleep(400)
    } else {
      skip('minimum-width detail reachability', "could not read the main window's minimum size")
    }

    await clickTaskRow(page, 'Task due today')
    await sleep(300)
    let ok = await clickDueDateQuickButton(page, 'Today')
    await sleep(400)
    let dueDateValue = await page.inputValue('[aria-label="Due date"]')
    check(
      '"Task due today"\'s due date is actually set to today, not just clicked',
      ok && dueDateValue === todayKey,
      `clicked: ${ok}, due date input: ${dueDateValue} (expected ${todayKey})`
    )

    // Subtask, while the detail panel is open.
    await page.fill('[aria-label="Add a subtask"]', 'A subtask')
    await page.press('[aria-label="Add a subtask"]', 'Enter')
    await sleep(400)
    const subtaskVisible = await page.isVisible('text=A subtask')
    check('subtask created via the UI', subtaskVisible)

    // At the app's default window size the task detail panel is commonly an overlay (this
    // is the very layout this suite exists to exercise — see `checkDetailAndListReachable`
    // above), so the previous task's detail has to be closed before another row is
    // reachable, same as a real user would have to.
    await page.click('[aria-label="Close details"]')
    await sleep(200)

    await clickTaskRow(page, 'Task due tomorrow')
    await sleep(300)
    ok = await clickDueDateQuickButton(page, 'Tomorrow')
    await sleep(400)
    dueDateValue = await page.inputValue('[aria-label="Due date"]')
    check(
      '"Task due tomorrow"\'s due date is actually set to tomorrow, not just clicked',
      ok && dueDateValue === tomorrowKey,
      `clicked: ${ok}, due date input: ${dueDateValue} (expected ${tomorrowKey})`
    )

    await page.click('[aria-label="Close details"]')
    await sleep(200)

    // ── Today view ─────────────────────────────────────────────────────────────
    await page.click('button:has-text("Today")')
    await sleep(500)
    let body = await page.evaluate(() => document.body.innerText)
    check(
      'Today view shows a "Today · <weekday>" group',
      /Today\s*·\s*[A-Za-z]{3}/i.test(body),
      body.match(/Today[^\n]*/g)?.join(' | ') ?? '(not found)'
    )
    check('Today view lists the task due today', body.includes('Task due today'))

    // ── Upcoming view ──────────────────────────────────────────────────────────
    await page.click('button:has-text("Upcoming")')
    await sleep(500)
    body = await page.evaluate(() => document.body.innerText)
    check(
      'Upcoming view shows a "Tomorrow · <weekday>" group',
      /Tomorrow\s*·\s*[A-Za-z]{3}/i.test(body),
      body.match(/Tomorrow[^\n]*/g)?.join(' | ') ?? '(not found)'
    )
    check('Upcoming view lists the task due tomorrow', body.includes('Task due tomorrow'))

    // ── Complete a task via the UI ────────────────────────────────────────────
    await page.click('button:has-text("Today")')
    await sleep(400)
    await page.click('[aria-label="Complete Task due today, Normal"]')
    await sleep(500)
    body = await page.evaluate(() => document.body.innerText)
    const completedRow = (await page.evaluate(() => window.flowdo.tasks.listCompleted(null, 50))).find(
      (t) => t.title === 'Task due today'
    )
    check(
      'completing via the UI marks it done (API) and drops it from the open Today list (UI)',
      !!completedRow && completedRow.completedAt !== null && !body.includes('Task due today'),
      JSON.stringify({ completedAt: completedRow?.completedAt ?? null, stillInBody: body.includes('Task due today') })
    )

    // ── Delete a task via the UI ──────────────────────────────────────────────
    await page.click('text=E2E Project')
    await sleep(400)
    await clickTaskRow(page, 'Task to delete')
    await sleep(300)
    await page.click('button:has-text("Delete task")')
    await sleep(200)
    await page.click('button:has-text("Delete task")')
    await sleep(500)
    body = await page.evaluate(() => document.body.innerText)
    const [openAfterDelete, completedAfterDelete] = await page.evaluate(() =>
      Promise.all([window.flowdo.tasks.list(), window.flowdo.tasks.listCompleted(null, 50)])
    )
    const stillExists = [...openAfterDelete, ...completedAfterDelete].some((t) => t.title === 'Task to delete')
    check(
      'deleting via the UI removes the task from the database (API), not just off screen (UI)',
      !stillExists && !body.includes('Task to delete'),
      JSON.stringify({ stillExistsInDb: stillExists, stillInBody: body.includes('Task to delete') })
    )

    skip('reorder', 'optional per spec — HTML5 drag-and-drop is not exercised by this harness')
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
