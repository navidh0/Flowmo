/**
 * theme — `settings.theme` drives `document.documentElement.dataset.theme` in every window
 * (main and mini, set by App.tsx — see its own comment for why that's an attribute rather
 * than reading `prefers-color-scheme` directly), and with it the painted CSS colours
 * (`assets/index.css`'s `:root[data-theme="light"]` block) and each window's pre-paint
 * background (`BrowserWindow#getBackgroundColor()`, from `src/main/windows.ts`). Also
 * captures a light and a dark screenshot of every main screen (plus the mini widget, plus a
 * scene with every `block.color` case a timeline block can render — two project swatches, a
 * no-project block, a break block, and a stopped-early block; see `BLOCK_SELECTOR` — into
 * e2e/out for a human to eyeball. Always restores `theme: 'system'` at the end, even on
 * failure, so a later suite in the same run never inherits a forced theme.
 *
 * No calendar-event case: `calendars.add()` fetches and parses a real feed URL before saving
 * it (its own doc comment in src/shared/types.ts), and there's no local ICS fixture server
 * wired into e2e the way `tests/todoist-fake-server.ts` is for vitest — not cheap enough to
 * add here, so `--color-swatch-event`'s fill is left to the token-level proof in
 * `tests/theme-surface.test.ts` (identical in both palettes, ≥4.5:1 against `--color-on-
 * swatch`) rather than a seeded screenshot.
 */

import { launch, quit, makeProfile, makeReporter, getMini, getMiniPage, outDir, sleep, waitFor } from '../lib/harness.mjs'
import { join } from 'node:path'

const LIGHT = { rgb: 'rgb(246, 247, 249)', hex: '#f6f7f9' }
const DARK = { rgb: 'rgb(15, 17, 21)', hex: '#0f1115' }
const AMBER = '#f59e0b'
const LIME = '#84cc16'

/** Every kind of timeline block this suite seeds: a project/no-project focus session or a
 *  break — never a calendar event (see the file header on why that case is skipped). Blocks
 *  are `<div>`s whose `aria-label` always starts with `block.title` (blocks.ts) followed by
 *  ` · `; NavBar's own "Focus" nav button has no such suffix, so this can't accidentally
 *  match it (a bug the first version of this suite had). */
const BLOCK_SELECTOR = '[aria-label^="Focus · "], [aria-label^="Short break · "], [aria-label^="Long break · "]'

/** `BrowserWindow#getBackgroundColor()` of the main (non-mini) window, or null if it's gone. */
async function mainBackgroundColor(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()
      .filter((x) => !x.isDestroyed() && !x.webContents.isDestroyed())
      .find((x) => !x.webContents.getURL().includes('mini'))
    return w ? w.getBackgroundColor() : null
  })
}

/** `BrowserWindow#getBackgroundColor()` of the mini window, or null if it's gone. */
async function miniBackgroundColor(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()
      .filter((x) => !x.isDestroyed() && !x.webContents.isDestroyed())
      .find((x) => x.webContents.getURL().includes('mini'))
    return w ? w.getBackgroundColor() : null
  })
}

/** Case-insensitive match, tolerant of an Electron-added alpha suffix ('#F6F7F9FF'). */
function hexMatches(actual, expectedHex) {
  return typeof actual === 'string' && actual.toUpperCase().startsWith(expectedHex.toUpperCase())
}

async function datasetTheme(page) {
  return page.evaluate(() => document.documentElement.dataset.theme)
}

/** Sets `settings.theme` through the real API — the only thing that drives the app's theme;
 *  nothing here forces the renderer's appearance directly (see the file header). */
async function setTheme(page, theme) {
  await page.evaluate((t) => window.flowdo.settings.set({ theme: t }), theme)
}

/**
 * `document.documentElement.dataset.theme`, the body background and `getBackgroundColor()`
 * all agree with `tone` ('light' | 'dark') for one window. `dataset.theme` is waited for
 * since App.tsx applies it from a settings broadcast, not synchronously with `settings.set`'s
 * own IPC round trip.
 */
async function checkWindowTheme(page, app, { label, isMini, tone, check }) {
  const expected = tone === 'light' ? LIGHT : DARK

  const matched = await waitFor(async () => (await datasetTheme(page)) === tone, 4000)
  const got = await datasetTheme(page)
  check(`${label} data-theme is "${tone}" after settings.set({ theme: "${tone}" })`, matched, got)

  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  check(`${label} body background is the ${tone} surface colour`, bg === expected.rgb, bg)

  const winBg = isMini ? await miniBackgroundColor(app) : await mainBackgroundColor(app)
  check(`${label}'s getBackgroundColor() is the ${tone} surface`, hexMatches(winBg, expected.hex), winBg ?? '(no window)')
}

/** Under `theme: 'system'`, `dataset.theme` should be whatever THIS window's own
 *  `matchMedia('(prefers-color-scheme: dark)')` says — light and dark are both valid, only
 *  disagreement between the two is a bug. */
async function checkSystemAgreement(page, { label, check }) {
  const theme = await waitFor(async () => {
    const t = await datasetTheme(page)
    return t === 'light' || t === 'dark' ? t : null
  }, 4000)
  check(`${label} data-theme is light or dark under theme: "system"`, theme === 'light' || theme === 'dark', theme)

  const prefersDark = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const expected = prefersDark ? 'dark' : 'light'
  check(
    `${label} data-theme agrees with its own matchMedia under theme: "system"`,
    theme === expected,
    JSON.stringify({ datasetTheme: theme, matchMediaPrefersDark: prefersDark })
  )
}

async function screenshotScreens(page, tone, check) {
  const shots = [
    { name: 'focus', aria: 'Focus', content: '[aria-label="New project"]' },
    { name: 'calendar', aria: 'Calendar', content: '[role="radiogroup"][aria-label="Timeline view"]' },
    { name: 'stats', aria: 'Stats', content: 'h1:has-text("Stats")' },
    { name: 'settings', aria: 'Settings', content: 'h1:has-text("Settings")' }
  ]

  for (const { name, aria, content } of shots) {
    await page.click(`[aria-label="${aria}"]`)
    await sleep(350)
    const visible = await page.isVisible(content)
    check(`${tone} ${name} screen renders before screenshot`, visible)

    if (name === 'calendar') {
      await page.click('role=radio[name="Week"]')
      await sleep(400)
      const weekChecked = await page.getAttribute('role=radio[name="Week"]', 'aria-checked')
      check(`${tone} calendar switched to Week view`, weekChecked === 'true')
    }

    await page.screenshot({ path: join(outDir, `theme-${tone}-${name}.png`) })
  }

  // A task row + its detail panel, distinct from the plain Focus screenshot above — exercises
  // the priority swatches, borders and hover surfaces the bare task list doesn't. The row may
  // already be selected (and its detail overlay open) from an earlier pass over this same
  // seeded task, in which case clicking the row again would hit the overlay instead of the
  // row underneath it (same overlay-vs-list geometry `tasks.mjs` documents) — closing the
  // detail panel first, best-effort, makes this idempotent across the light and dark passes.
  await page.click('[aria-label="Focus"]')
  await sleep(300)
  const closeDetails = page.locator('[aria-label="Close details"]')
  if (await closeDetails.isVisible().catch(() => false)) {
    await closeDetails.click()
    await sleep(200)
  }
  const row = page.locator('button[data-task-row]', { hasText: 'Theme e2e task' })
  const rowVisible = await row.isVisible().catch(() => false)
  if (rowVisible) {
    await row.click()
    await sleep(300)
  }
  check(`${tone} tasks screen has the seeded task selected`, rowVisible)
  await page.screenshot({ path: join(outDir, `theme-${tone}-tasks.png`) })
}

/** A project with one task under it, via the real IPC API (`projects.create`/`tasks.create`),
 *  the same surface `e2e/suites/data.mjs` and `tasks.mjs` seed through. */
async function seedProjectWithTask(page, projectName, taskTitle, color) {
  const project = await page.evaluate(
    ({ name, color }) => window.flowdo.projects.create({ name, color }),
    { name: projectName, color }
  )
  const task = await page.evaluate(
    ({ projectId, title }) => window.flowdo.tasks.create({ projectId, title }),
    { projectId: project.id, title: taskTitle }
  )
  return { projectId: project.id, taskId: task.id }
}

/**
 * Logs one COMPLETED focus session against `taskId` (and so against its project — see
 * `getProjectIdForTask` in src/main/timer.ts), so it renders as a normal (non-abandoned)
 * `block.color`-filled timeline block. A tiny Pomodoro plan that expires on its own — not
 * `stop()`/`skip()` — is what earns `completed: true`: `isPhaseComplete()` in
 * src/main/timer.ts only treats a bounded (Pomodoro) phase as complete once it actually
 * reaches its plan, same rule `e2e/suites/timer.mjs` relies on for its own Pomodoro checks.
 */
async function completeTinySession(page, taskId) {
  await page.evaluate(() =>
    window.flowdo.settings.set({
      mode: 'pomodoro',
      pomodoroFocusMs: 3000,
      pomodoroShortBreakMs: 2000,
      pomodoroLongBreakMs: 2000,
      longBreakEvery: 99,
      autoStartBreaks: false,
      autoStartFocus: false
    })
  )
  await page.evaluate(() => window.flowdo.timer.setMode('pomodoro', 'discard'))
  await page.evaluate((id) => window.flowdo.timer.setTask(id), taskId)
  await page.evaluate(() => window.flowdo.timer.start())
  await waitFor(async () => {
    const recent = await page.evaluate(() => window.flowdo.sessions.recent(10))
    return recent.some((s) => s.taskId === taskId && s.kind === 'focus' && s.completed === true)
  }, 8000)
}

/**
 * Logs one ABANDONED (stopped-early) focus session. `PhaseEndEvent.completed`'s own doc in
 * src/shared/types.ts ("Pomodoro: reached plannedMs. Flowmodoro focus: always true") is
 * exactly what `isPhaseComplete()`/`stop()` in src/main/timer.ts implement — a Flowmodoro
 * focus phase has no plan to fall short of, so `stop()` always logs it `completed: true`,
 * which is NOT abandoned. A bounded Pomodoro phase stopped before it reaches its plan is the
 * one way to get `completed: false`, so this uses a plan long enough that a ~1s stop can't
 * reach it. No task attached, so it renders with the neutral tint, not a project swatch —
 * this block exists to prove requirement 4 (abandoned blocks use `--color-text`), not the
 * swatch fill.
 */
async function logAbandonedSession(page) {
  await page.evaluate(() =>
    window.flowdo.settings.set({
      mode: 'pomodoro',
      pomodoroFocusMs: 30_000,
      pomodoroShortBreakMs: 2000,
      pomodoroLongBreakMs: 2000,
      longBreakEvery: 99,
      autoStartBreaks: false,
      autoStartFocus: false
    })
  )
  await page.evaluate(() => window.flowdo.timer.setMode('pomodoro', 'discard'))
  await page.evaluate(() => window.flowdo.timer.setTask(null))
  await page.evaluate(() => window.flowdo.timer.start())
  await sleep(1200)
  await page.evaluate(() => window.flowdo.timer.stop())
}

/**
 * Logs a completed NO-PROJECT focus session (renders with `--color-swatch-neutral`, the most
 * common block in the real app — any session with no project attached), immediately followed
 * by a BREAK session (`--color-swatch-break`), auto-started the same way
 * `e2e/suites/timer.mjs`'s own "phase ends and auto-starts the break" check relies on. A
 * break is never "abandoned" — `blocks.ts`'s `abandoned` flag is hard-wired to
 * `kind !== 'break'` — so simply stopping it after a moment renders it solid regardless of
 * whether it reached its own plan; no need to wait for it to finish naturally.
 */
async function completeNoProjectFocusThenBreak(page) {
  await page.evaluate(() =>
    window.flowdo.settings.set({
      mode: 'pomodoro',
      pomodoroFocusMs: 3000,
      pomodoroShortBreakMs: 3000,
      pomodoroLongBreakMs: 3000,
      longBreakEvery: 99,
      autoStartBreaks: true,
      autoStartFocus: false
    })
  )
  await page.evaluate(() => window.flowdo.timer.setMode('pomodoro', 'discard'))
  await page.evaluate(() => window.flowdo.timer.setTask(null))
  await page.evaluate(() => window.flowdo.timer.start())
  await waitFor(async () => {
    const s = await page.evaluate(() => window.flowdo.timer.getState())
    return s.kind !== null && s.kind !== 'focus' ? s : null
  }, 8000)
  await sleep(1200)
  await page.evaluate(() => window.flowdo.timer.stop())
}

/**
 * A real, seconds-long e2e-seeded session renders as a sub-pixel sliver on the timeline grid
 * (fixed 56px-per-hour scale — src/renderer/src/components/timeline/HourGrid.tsx's
 * `ROW_HEIGHT_PX`; a real 3-second session is 56 * 3/3600 ≈ 0.05px tall), the same as it
 * would for ANY quick real session — nothing to do with theme. So for the screenshot only
 * (never touching product code, never changing what colour/text anything computes to), lay
 * the seeded blocks out at a fixed, readable size and position, purely so a human can see
 * them. The DOM-level colour checks in `screenshotSwatches` below are what actually PROVES
 * requirements 3 and 4 — this is just for eyeballing.
 */
async function embiggenBlocksForScreenshot(page, selector) {
  await page.evaluate((selector) => {
    const blocks = Array.from(document.querySelectorAll(selector))
    blocks.forEach((el, i) => {
      const outer = el.parentElement
      if (!(outer instanceof HTMLElement)) return
      outer.style.top = `${40 + i * 48}px`
      outer.style.height = '40px'
      outer.style.left = '8px'
      outer.style.width = '280px'
    })
    blocks[0]?.scrollIntoView({ block: 'center' })
  }, selector)
}

/** Every `BLOCK_SELECTOR`-matched timeline block's fill/text colour (as rendered hex), plus
 *  the current `--color-on-swatch`/`--color-swatch-neutral`/`--color-swatch-break`/
 *  `--color-text` custom property values — read from the live DOM rather than hard-coded, so
 *  this can't drift from whatever index.css actually declares. The actual proof that
 *  requirements 3 and 4 hold, independent of whether the screenshot is legible at the seeded
 *  blocks' real (sub-pixel) size. */
async function inspectSwatchBlocks(page, selector) {
  return page.evaluate((sel) => {
    const rgbToHex = (rgb) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb)
      if (!m) return null
      return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
    }
    const root = getComputedStyle(document.documentElement)
    const prop = (name) => root.getPropertyValue(name).trim().toLowerCase()
    const tokens = {
      onSwatch: prop('--color-on-swatch'),
      onText: prop('--color-text'),
      swatchNeutral: prop('--color-swatch-neutral'),
      swatchBreak: prop('--color-swatch-break')
    }
    const blocks = Array.from(document.querySelectorAll(sel)).map((el) => ({
      label: el.getAttribute('aria-label'),
      bg: rgbToHex(getComputedStyle(el).backgroundColor),
      color: rgbToHex(getComputedStyle(el).color)
    }))
    return { ...tokens, blocks }
  }, selector)
}

async function screenshotSwatches(page, tone, check) {
  await page.click('[aria-label="Calendar"]')
  await sleep(400)
  await page.click('role=radio[name="Day"]')
  await sleep(400)

  const inspected = await inspectSwatchBlocks(page, BLOCK_SELECTOR)

  const amberBlock = inspected.blocks.find((b) => b.bg === AMBER)
  check(`${tone} amber project block renders with the amber fill`, !!amberBlock, JSON.stringify(inspected.blocks))
  check(
    `${tone} amber block text uses --color-on-swatch, not --color-on-accent`,
    amberBlock?.color === inspected.onSwatch,
    JSON.stringify({ got: amberBlock?.color, expected: inspected.onSwatch })
  )

  const limeBlock = inspected.blocks.find((b) => b.bg === LIME)
  check(`${tone} lime project block renders with the lime fill`, !!limeBlock, JSON.stringify(inspected.blocks))
  check(
    `${tone} lime block text uses --color-on-swatch, not --color-on-accent`,
    limeBlock?.color === inspected.onSwatch,
    JSON.stringify({ got: limeBlock?.color, expected: inspected.onSwatch })
  )

  // The abandoned block's own `background-color` is `transparent` (Block.tsx: only its
  // border/stripe tint is `block.color`, i.e. `--color-swatch-neutral` here) — computes to
  // `rgba(0, 0, 0, 0)`, which `rgbToHex` reads as `#000000`, never `swatchNeutral` — so it's
  // found by its "stopped early" label, same as calendar.mjs/stats.mjs do for abandoned
  // sessions, not by background colour. The COMPLETED no-project block, by contrast, really
  // is filled with `--color-swatch-neutral` — found by that background colour AND the
  // absence of "stopped early", so the two can never accidentally match each other.
  const abandonedBlock = inspected.blocks.find((b) => (b.label ?? '').includes('stopped early'))
  const completedNeutralBlock = inspected.blocks.find(
    (b) => b.bg === inspected.swatchNeutral && !(b.label ?? '').includes('stopped early')
  )

  check(`${tone} stopped-early block is present`, !!abandonedBlock, JSON.stringify(inspected.blocks))
  check(
    `${tone} stopped-early block text uses --color-text, not on-swatch/on-accent`,
    abandonedBlock?.color === inspected.onText,
    JSON.stringify({ got: abandonedBlock?.color, expected: inspected.onText })
  )

  check(
    `${tone} completed no-project block renders with the swatch-neutral fill`,
    !!completedNeutralBlock,
    JSON.stringify(inspected.blocks)
  )
  check(
    `${tone} no-project block text uses --color-on-swatch, not --color-on-accent`,
    completedNeutralBlock?.color === inspected.onSwatch,
    JSON.stringify({ got: completedNeutralBlock?.color, expected: inspected.onSwatch })
  )

  const breakBlock = inspected.blocks.find((b) => b.bg === inspected.swatchBreak)
  check(`${tone} break block renders with the swatch-break fill`, !!breakBlock, JSON.stringify(inspected.blocks))
  check(
    `${tone} break block text uses --color-on-swatch, not --color-on-accent`,
    breakBlock?.color === inspected.onSwatch,
    JSON.stringify({ got: breakBlock?.color, expected: inspected.onSwatch })
  )

  await embiggenBlocksForScreenshot(page, BLOCK_SELECTOR)
  await page.screenshot({ path: join(outDir, `theme-${tone}-swatches.png`) })
}

export async function run() {
  const { check, results } = makeReporter('theme')
  const profile = makeProfile('flowdo-e2e-theme-')

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page

    // ── Seed one project + task, so the "tasks" screenshot has a real detail panel ────────
    await page.click('[aria-label="New project"]')
    await page.fill('[aria-label="New project name"]', 'Theme E2E Project')
    await page.press('[aria-label="New project name"]', 'Enter')
    await sleep(300)
    await page.fill('[aria-label="Add a task"]', 'Theme e2e task')
    await page.press('[aria-label="Add a task"]', 'Enter')
    await sleep(300)

    // ── Seed every timeline block colour case (requirements 3 & 4): two project swatches, a
    // stopped-early block, a no-project ("neutral") block, and a break block ──────────────
    const amber = await seedProjectWithTask(page, 'Amber Swatch Project', 'Amber task', AMBER)
    const lime = await seedProjectWithTask(page, 'Lime Swatch Project', 'Lime task', LIME)
    await completeTinySession(page, amber.taskId)
    await completeTinySession(page, lime.taskId)
    await logAbandonedSession(page)
    await completeNoProjectFocusThenBreak(page)

    // ── theme: light ────────────────────────────────────────────────────────────────────
    await setTheme(page, 'light')
    await checkWindowTheme(page, app, { label: 'main window', isMini: false, tone: 'light', check })

    await screenshotScreens(page, 'light', check)
    await screenshotSwatches(page, 'light', check)

    // Mini widget follows the same setting.
    await page.evaluate(() => window.flowdo.settings.set({ showMiniWidget: true }))
    const miniShown = await waitFor(() => getMini(app))
    check('mini widget opens (pinned) to check its theme', !!miniShown)
    if (miniShown) {
      const miniPage = getMiniPage(app)
      if (miniPage) {
        await checkWindowTheme(miniPage, app, { label: 'mini window', isMini: true, tone: 'light', check })
        await miniPage.screenshot({ path: join(outDir, 'theme-light-mini.png') })
      }
    }
    await page.evaluate(() => window.flowdo.settings.set({ showMiniWidget: false }))
    check('unpinning the mini widget closes it', !!(await waitFor(async () => (await getMini(app)) === null)))

    // ── theme: dark ─────────────────────────────────────────────────────────────────────
    await setTheme(page, 'dark')
    await checkWindowTheme(page, app, { label: 'main window', isMini: false, tone: 'dark', check })

    await screenshotScreens(page, 'dark', check)
    await screenshotSwatches(page, 'dark', check)

    // ── restore ─────────────────────────────────────────────────────────────────────────
    await setTheme(page, 'system')
    await checkSystemAgreement(page, { label: 'main window', check })
    const restored = await page.evaluate(() => window.flowdo.settings.get())
    check('theme restored to system at the end of the suite', restored.theme === 'system', restored.theme)
  } finally {
    if (app) await quit(app)
    profile.cleanup()
  }

  return results
}
