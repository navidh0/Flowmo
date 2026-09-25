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

import { launch, quit, makeProfile, makeReporter, sleep } from '../lib/harness.mjs'

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

export async function run() {
  const { check, skip, results } = makeReporter('tasks')
  const profile = makeProfile('flowdo-e2e-tasks-')

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page

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

    await page.click('button[data-task-row]:has-text("Task due today")')
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

    await page.click('button[data-task-row]:has-text("Task due tomorrow")')
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
    await page.click('button[data-task-row]:has-text("Task to delete")')
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
