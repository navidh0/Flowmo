/**
 * timeline — the layered Day/Week timeline (`timeline/layout.ts`'s `layoutTimeline`,
 * `timeline/blocks.ts`'s `eventFill`, `timeline/Block.tsx`): calendar events render as a
 * translucent full-width background layer and focus/break/running sessions as a solid
 * foreground layer drawn on top, with no z-index anywhere in the block wrappers (see
 * `Block.tsx`'s header for why).
 *
 * Seeds a real ICS feed from a throwaway `http.createServer` on 127.0.0.1 in this process —
 * the app's `normalizeFeedUrl` (src/main/integrations/ical/fetch.ts) only accepts `http://`
 * for `localhost`/`127.0.0.1`, exactly so a test like this can point a feed at itself — with
 * three timed events today: E1/E2 overlap each other, and E3 spans a short logged focus
 * session with wide (>= 30 min) margins on both sides, so the session sits well inside E3's
 * time range regardless of exactly when this suite happens to run. `calendars.add()` fetches,
 * parses and stores events before it resolves (see its own doc comment in
 * src/main/integrations/ical/index.ts), so the events are already in the DB by the time the
 * Calendar screen's own first load reads them — no separate refresh call needed.
 *
 * Checks both Day and Week views, in both themes, then screenshots all four combinations —
 * including a regression check that the seeded (real, few-second) session's label text stays
 * clipped to its own tiny box rather than spilling downward over the gridlines/next block
 * (Block.tsx moved the clip from the whole block div to a small wrapper around just the
 * label, precisely so the tooltip — checked separately below — stays unclipped).
 *
 * `calendars.add()` needs OS-backed secret storage to keep the feed's URL encrypted
 * (src/main/credentials.ts — there is deliberately no plaintext fallback), which a bare
 * Linux container has no reason to have: no session D-Bus, no keyring daemon. Rather than
 * touch shared harness/launch code (out of this suite's scope), this suite starts its own
 * throwaway session D-Bus + `gnome-keyring-daemon` and points ONLY its own `launch()` call at
 * them (`--password-store=gnome-libsecret` + env), so `safeStorage.isEncryptionAvailable()`
 * has a real backend to report. If `dbus-launch`/`gnome-keyring-daemon` aren't installed at
 * all, or the feed still can't be added, the suite reports that and SKIPs the rest rather
 * than crashing — this is infrastructure bootstrapping, not something worth failing the run
 * over on a machine that genuinely has neither.
 *
 * Also covers the Today view's "Sync now" button (`components/tasks/SyncNowButton.tsx`):
 * absent with no provider connected, present once the feed above makes calendars connected,
 * absent again on Upcoming, and — the one behavioural check — that clicking it (never
 * `calendars.refreshNow()` called directly, never a page reload) is what makes a feed body
 * changed after the app already loaded actually show up in the Day timeline. That needs the
 * feed server's body to change mid-run, which is why `startIcsServer` hands back a
 * `setBody` rather than baking a fixed body into the request handler.
 */

import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, quit, makeProfile, makeReporter, outDir, sleep, waitFor } from '../lib/harness.mjs'

const MINUTE = 60_000

function execFileP(cmd, args, opts) {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolvePromise({ stdout, stderr })
    })
  })
}

/**
 * Starts a private session D-Bus (`dbus-launch`) and an unlocked `gnome-keyring-daemon`
 * (`secrets` + `pkcs11` components — the same Secret Service Electron's `safeStorage` speaks
 * to on Linux), both under a throwaway `$HOME`, and returns the env/args a `launch()` call
 * needs to make Electron pick that backend up (`getSelectedStorageBackend()` returns
 * `gnome_libsecret`). Never throws — returns `null` on any failure (missing binary, spawn
 * error), so the caller can skip gracefully.
 */
async function startSecretService() {
  try {
    const keyringHome = mkdtempSync(join(tmpdir(), 'flowdo-e2e-keyring-'))
    const xdgRuntimeDir = join(keyringHome, 'run')
    mkdirSync(xdgRuntimeDir, { recursive: true, mode: 0o700 })

    const { stdout } = await execFileP('dbus-launch', ['--sh-syntax'])
    const addressMatch = /DBUS_SESSION_BUS_ADDRESS='([^']+)'/.exec(stdout)
    const pidMatch = /DBUS_SESSION_BUS_PID=(\d+)/.exec(stdout)
    if (!addressMatch || !pidMatch) throw new Error('could not parse dbus-launch output')
    const dbusAddress = addressMatch[1]
    const dbusPid = Number(pidMatch[1])

    const keyringEnv = {
      ...process.env,
      HOME: keyringHome,
      XDG_RUNTIME_DIR: xdgRuntimeDir,
      DBUS_SESSION_BUS_ADDRESS: dbusAddress
    }
    // `--foreground` (not `--daemonize`) keeps this a plain child process this suite owns
    // and can kill outright at teardown, rather than an orphaned background daemon.
    const keyring = spawn(
      'gnome-keyring-daemon',
      ['--unlock', '--foreground', '--components=secrets,pkcs11'],
      { env: keyringEnv, stdio: ['pipe', 'ignore', 'ignore'] }
    )
    keyring.on('error', () => {})
    // A fresh keyring has no password to check — an empty line is enough to "unlock" it.
    keyring.stdin.end('\n')
    await sleep(1000)

    return {
      env: { HOME: keyringHome, XDG_RUNTIME_DIR: xdgRuntimeDir, DBUS_SESSION_BUS_ADDRESS: dbusAddress },
      extraArgs: ['--password-store=gnome-libsecret'],
      cleanup() {
        try {
          keyring.kill('SIGKILL')
        } catch {
          /* best-effort */
        }
        try {
          process.kill(dbusPid, 'SIGKILL')
        } catch {
          /* best-effort */
        }
        try {
          rmSync(keyringHome, { recursive: true, force: true })
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    return null
  }
}

/** `YYYYMMDDTHHMMSSZ`, RFC 5545's plain-UTC form — the same shape `tests/fixtures/basic.ics`
 *  uses for its "UTC event" case, so no VTIMEZONE/TZID plumbing is needed here. */
function toIcsUtc(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
}

function buildIcs(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Flowdo E2E//Timeline//EN', 'CALSCALE:GREGORIAN']
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}@flowdo-e2e-timeline`,
      `DTSTAMP:${toIcsUtc(Date.now())}`,
      `DTSTART:${toIcsUtc(e.startMs)}`,
      `DTEND:${toIcsUtc(e.endMs)}`,
      `SUMMARY:${e.summary}`,
      'END:VEVENT'
    )
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}

/**
 * A throwaway ICS feed server bound to 127.0.0.1 only — never 0.0.0.0. Its body is mutable
 * (a closure variable, not baked into the request handler) so the "Sync now" checks below
 * can change what the feed serves and then re-fetch it, without standing up a second server.
 * It never sends an ETag/Last-Modified, so main's conditional-GET path (see
 * src/main/integrations/ical/fetch.ts) always re-parses the full body — exactly what makes
 * a body swap + re-sync observable at all.
 */
function startIcsServer(initialBody) {
  let body = initialBody
  return new Promise((resolvePromise, reject) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' })
      res.end(body)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolvePromise({
        server,
        url: `http://127.0.0.1:${port}/feed.ics`,
        setBody: (next) => {
          body = next
        }
      })
    })
  })
}

/** Resolves any CSS colour (a `var(...)`, a hex, whatever) to the browser's own canonical
 *  `rgb(...)` string via a throwaway element, so a comparison never hard-codes a hex the
 *  active theme could change out from under it. */
async function resolveColor(page, value) {
  return page.evaluate((v) => {
    const el = document.createElement('span')
    el.style.backgroundColor = v
    document.body.appendChild(el)
    const resolved = getComputedStyle(el).backgroundColor
    el.remove()
    return resolved
  }, value)
}

/**
 * Logs one real, short COMPLETED focus session with no project/task (renders with the
 * neutral swatch, not a project colour) via a tiny Pomodoro plan that expires on its own —
 * same technique as `e2e/suites/theme.mjs`'s `completeTinySession`, just without a task. Its
 * real start/end land at "now", which the caller arranges to fall inside E3's window.
 */
async function logTinyFocusSession(page) {
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
  await page.evaluate(() => window.flowdo.timer.setTask(null))
  await page.evaluate(() => window.flowdo.timer.start())
  await waitFor(async () => {
    const recent = await page.evaluate(() => window.flowdo.sessions.recent(5))
    return recent.some((s) => s.kind === 'focus' && s.completed === true)
  }, 8000)
}

/**
 * A block's own geometry plus its lane's width. `sel` must currently match exactly one
 * element. The "lane" is the block wrapper's parent — the flex/grid cell `HourGrid`/
 * `WeekView` map placements into — whose width IS the overlap column's full width (`Block`'s
 * wrapper is `left/width` percentages of exactly that box).
 */
async function blockGeometry(page, sel) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const wrapper = el.parentElement
    const lane = wrapper?.parentElement
    if (!wrapper || !lane) return null
    const elRect = el.getBoundingClientRect()
    const wrapperRect = wrapper.getBoundingClientRect()
    const laneRect = lane.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      elRect: {
        left: elRect.left,
        top: elRect.top,
        width: elRect.width,
        height: elRect.height
      },
      wrapperRect: { left: wrapperRect.left, width: wrapperRect.width },
      laneWidth: laneRect.width,
      background: style.backgroundColor,
      borderLeftColor: style.borderLeftColor
    }
  }, sel)
}

export async function run() {
  const { check, skip, results } = makeReporter('timeline')
  const profile = makeProfile('flowdo-e2e-timeline-')

  let app
  let icsServer
  let secretService

  try {
    const now = Date.now()
    // E3 spans the session with wide margins on both sides (the session itself lands a few
    // seconds after "now" below — well inside this). E1/E2 sit after E3 ends and overlap
    // each other by 15 minutes.
    const e3Start = now - 35 * MINUTE
    const e3End = now + 35 * MINUTE
    const e1Start = e3End + 10 * MINUTE
    const e1End = e1Start + 30 * MINUTE
    const e2Start = e1Start + 15 * MINUTE
    const e2End = e2Start + 30 * MINUTE

    const GAMMA_TITLE = 'Timeline E2E Gamma'
    const ALPHA_TITLE = 'Timeline E2E Alpha'
    const BETA_TITLE = 'Timeline E2E Beta'

    const icsBody = buildIcs([
      { uid: 'gamma', summary: GAMMA_TITLE, startMs: e3Start, endMs: e3End },
      { uid: 'alpha', summary: ALPHA_TITLE, startMs: e1Start, endMs: e1End },
      { uid: 'beta', summary: BETA_TITLE, startMs: e2Start, endMs: e2End }
    ])
    const { server, url: feedUrl, setBody: setIcsBody } = await startIcsServer(icsBody)
    icsServer = server

    secretService = await startSecretService()
    const launched = await launch({
      profile,
      extraArgs: secretService?.extraArgs ?? [],
      extraEnv: secretService?.env ?? {}
    })
    app = launched.app
    const page = launched.page

    // ── Sync now: absent before any feed exists ────────────────────────────────────────
    // The app opens on the Focus screen with the Today smart view already selected (its
    // store default — see `stores/tasks.ts`), and a fresh profile has neither Todoist
    // connected nor any calendar feed, so this is the one point in the suite where the
    // "no connected provider" case can be checked for free, before the feed below makes
    // calendars connected for the rest of the run.
    const syncNowAbsentInitially = !(await page.isVisible('[data-testid="sync-now"]'))
    check(
      '"Sync now" is absent from Today before any provider is connected',
      syncNowAbsentInitially
    )

    let feed = null
    let addError = null
    try {
      feed = await page.evaluate(
        (url) => window.flowdo.integrations.calendars.add({ name: 'Timeline E2E Feed', url }),
        feedUrl
      )
    } catch (err) {
      addError = err instanceof Error ? err.message : String(err)
    }
    check('the ICS feed was added', !!feed && typeof feed.id === 'number', addError ?? JSON.stringify(feed))

    if (!feed) {
      skip(
        'layered timeline checks (event/session rendering, both views, both themes)',
        `no calendar events to render — feed add failed${secretService ? '' : ' (no session D-Bus/gnome-keyring-daemon available to bootstrap secure storage in this environment)'}: ${addError}`
      )
      return results
    }

    // ── Sync now: appears on Today once a feed is connected, absent on Upcoming ─────────
    // `SyncNowButton` reads its providers once per mount rather than on every render (see
    // its own header on why it isn't tied to `useIntegrationsStore`'s longer-lived
    // lifecycle), and the instance that has been sitting on the Focus screen since launch
    // mounted before the feed above existed. A real user adds a feed from Settings, not
    // from the Today view itself, and comes back to Focus afterwards — so round-trip
    // through another screen here too, rather than expecting that still-mounted instance
    // to notice a feed added directly through the bridge underneath it.
    await page.click('[aria-label="Settings"]')
    await sleep(300)
    await page.click('[aria-label="Focus"]')
    await sleep(300)

    const syncNowVisibleOnToday = await waitFor(() => page.isVisible('[data-testid="sync-now"]'), 3000)
    check('Today view shows "Sync now" once a calendar feed is connected', syncNowVisibleOnToday)

    await page.click('button:has-text("Upcoming")')
    await sleep(300)
    const syncNowAbsentOnUpcoming = !(await page.isVisible('[data-testid="sync-now"]'))
    check('"Sync now" is absent from the Upcoming view', syncNowAbsentOnUpcoming)

    await page.click('button:has-text("Today")')
    await sleep(300)

    await logTinyFocusSession(page)

    await page.click('[aria-label="Calendar"]')
    await sleep(500)
    const timelineVisible = await page.isVisible('[role="radiogroup"][aria-label="Timeline view"]')
    check('calendar screen renders with the timeline view switcher', timelineVisible)

    const sel = (title) => `[aria-label^="${title} · "]`
    const GAMMA = sel(GAMMA_TITLE)
    const ALPHA = sel(ALPHA_TITLE)
    const BETA = sel(BETA_TITLE)
    const SESSION = '[aria-label^="Focus · "]'

    async function layeringChecks(view, tone) {
      const label = `${tone} ${view}`

      const gammaVisible = await waitFor(() => page.isVisible(GAMMA), 4000)
      check(`${label}: event E3 (Gamma) renders`, gammaVisible)
      if (!gammaVisible) return

      // Week view has no horizontal auto-scroll-to-today (only the vertical scroll-to-now
      // this suite's own testing found broken and this pass fixed — see WeekView.tsx); on a
      // narrow panel today's own column can still start past the right edge. Bring it fully
      // into view before reading any geometry below, in both dimensions, in both views (a
      // no-op wherever it is already visible).
      await page.locator(GAMMA).scrollIntoViewIfNeeded()

      const sessionVisible = await page.isVisible(SESSION)
      check(`${label}: the seeded session renders`, sessionVisible)

      const gamma = await blockGeometry(page, GAMMA)
      const session = sessionVisible ? await blockGeometry(page, SESSION) : null

      // (a) nothing else overlaps E3 in time, so its own cluster is columns:1 — its wrapper
      // should be within 2px of its lane's full width.
      check(
        `${label}: E3's block width matches its (full, columns:1) lane width`,
        !!gamma && Math.abs(gamma.wrapperRect.width - gamma.laneWidth) <= 2,
        gamma ? JSON.stringify({ wrapper: gamma.wrapperRect.width, lane: gamma.laneWidth }) : 'no geometry'
      )

      if (session && gamma) {
        // (b) the point at the session's own centre resolves to the session, not to E3
        // underneath it — DOM order alone (events before sessions), never a z-index. Rect +
        // hit-test happen in the SAME evaluate call: two round trips here risked the page's
        // own auto-scroll (WeekView/HourGrid both scroll themselves to "now" on mount)
        // landing in between and turning yesterday's coordinates stale.
        const hit = await page.evaluate(
          ({ sessionSel, eventSel }) => {
            const s = document.querySelector(sessionSel)
            if (!s) return { inSession: false, inEvent: false, missing: true }
            const r = s.getBoundingClientRect()
            const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
            return { inSession: !!el?.closest(sessionSel), inEvent: !!el?.closest(eventSel) }
          },
          { sessionSel: SESSION, eventSel: GAMMA }
        )
        check(
          `${label}: elementFromPoint at the session's centre hits the session, not E3`,
          hit.inSession && !hit.inEvent,
          JSON.stringify(hit)
        )

        // (g) a real, very short block's label text must not spill past its own bottom edge.
        // This session is a few real seconds long — far under a minute — so its own rendered
        // height is a handful of px, well under the label's natural line height; Block.tsx
        // clips the label inside its own small `absolute inset-0 overflow-hidden` wrapper
        // rather than the whole block div (which would also reclip the tooltip checked in
        // (f) below — see Block.tsx's header). Checked two ways: the wrapper's natural
        // content height is confirmed genuinely taller than its clipped (rendered) height —
        // proving this is a real overflow case, not a vacuous one — and a point just past the
        // block's own bottom edge, exactly where the label's unclipped text would otherwise
        // paint, must resolve to something other than this block.
        const labelClip = await page.evaluate(
          (sel) => {
            const s = document.querySelector(sel)
            const wrapper = s?.firstElementChild
            if (!s || !(wrapper instanceof HTMLElement)) return { missing: true }
            const r = s.getBoundingClientRect()
            const el = document.elementFromPoint(r.left + r.width / 2, r.bottom + 3)
            return {
              blockHeight: r.height,
              wrapperClientHeight: wrapper.clientHeight,
              wrapperScrollHeight: wrapper.scrollHeight,
              spillsBelow: !!el?.closest(sel)
            }
          },
          SESSION
        )
        check(
          `${label}: the short session is a genuine overflow case (label content taller than its clipped box)`,
          !labelClip.missing && labelClip.wrapperScrollHeight > labelClip.wrapperClientHeight,
          JSON.stringify(labelClip)
        )
        check(
          `${label}: the short session's label text doesn't spill below its own bottom edge`,
          !labelClip.missing && !labelClip.spillsBelow,
          JSON.stringify(labelClip)
        )

        // (c) the session insets from E3's own left edge (the over-event inset).
        check(
          `${label}: the session's left edge sits right of E3's`,
          session.wrapperRect.left > gamma.wrapperRect.left + 1,
          JSON.stringify({ session: session.wrapperRect.left, event: gamma.wrapperRect.left })
        )

        // (e) E3's tint differs from its own stripe colour; the session is a plain solid fill.
        check(
          `${label}: E3's background tint differs from its border-left stripe colour`,
          gamma.background !== gamma.borderLeftColor,
          JSON.stringify({ background: gamma.background, borderLeft: gamma.borderLeftColor })
        )
        const neutralSwatch = await resolveColor(page, 'var(--color-swatch-neutral)')
        check(
          `${label}: the session's background is the solid neutral swatch, not a tint`,
          session.background === neutralSwatch,
          JSON.stringify({ got: session.background, expected: neutralSwatch })
        )
      }

      // (d) E1/E2 overlap each other in time and sit side by side: similar, roughly-half-lane
      // widths, different lefts.
      const alpha = await blockGeometry(page, ALPHA)
      const beta = await blockGeometry(page, BETA)
      check(
        `${label}: E1/E2 (overlapping events) get similar, roughly-half-lane widths`,
        !!alpha &&
          !!beta &&
          Math.abs(alpha.wrapperRect.width - beta.wrapperRect.width) <= 3 &&
          Math.abs(alpha.wrapperRect.width - alpha.laneWidth / 2) <= 6,
        JSON.stringify({ alpha: alpha?.wrapperRect, beta: beta?.wrapperRect, lane: alpha?.laneWidth })
      )
      check(
        `${label}: E1/E2 sit at different left offsets (side by side, not stacked)`,
        !!alpha && !!beta && Math.abs(alpha.wrapperRect.left - beta.wrapperRect.left) > 5,
        JSON.stringify({ alpha: alpha?.wrapperRect.left, beta: beta?.wrapperRect.left })
      )

      // (f) hover + focus E3: its tooltip becomes visible and still wins elementFromPoint at
      // its own centre, even at a point that also falls inside the session's bounding box.
      // Hover near E3's own top-left corner, not its bounding-box centre: the session drawn
      // over it (inset from the left, and starting well after E3's own start — see the
      // margins above) would otherwise intercept a centred hover, which is the whole point
      // of this check but exactly what defeats Playwright's own actionability probe.
      const gammaLocator = page.locator(GAMMA)
      await gammaLocator.hover({ position: { x: 2, y: 2 } })
      await gammaLocator.focus()
      const tooltipSel = `${GAMMA} [role="tooltip"]`
      const tooltipShown = await waitFor(async () => {
        const opacity = await page.evaluate((tsel) => {
          const t = document.querySelector(tsel)
          return t ? getComputedStyle(t).opacity : null
        }, tooltipSel)
        return opacity === '1'
      }, 3000)
      check(`${label}: E3's tooltip becomes visible on hover+focus`, tooltipShown)

      if (tooltipShown) {
        // Rect + hit-test in the SAME evaluate call — see the (b) check's own comment on why.
        const result = await page.evaluate(
          ({ tsel, ssel }) => {
            const t = document.querySelector(tsel)
            const s = document.querySelector(ssel)
            const tr = t.getBoundingClientRect()
            const sr = s ? s.getBoundingClientRect() : null
            let x, y, overSession
            if (sr) {
              const ix1 = Math.max(tr.left, sr.left)
              const iy1 = Math.max(tr.top, sr.top)
              const ix2 = Math.min(tr.right, sr.right)
              const iy2 = Math.min(tr.bottom, sr.bottom)
              overSession = ix2 > ix1 && iy2 > iy1
              x = overSession ? (ix1 + ix2) / 2 : tr.left + tr.width / 2
              y = overSession ? (iy1 + iy2) / 2 : tr.top + tr.height / 2
            } else {
              x = tr.left + tr.width / 2
              y = tr.top + tr.height / 2
              overSession = false
            }
            const hitsTooltip = !!document.elementFromPoint(x, y)?.closest(tsel)
            return { x, y, overSession, hitsTooltip }
          },
          { tsel: tooltipSel, ssel: SESSION }
        )
        check(
          `${label}: elementFromPoint at the tooltip's centre hits the tooltip${result.overSession ? ' (there, over the session)' : ''}`,
          result.hitsTooltip,
          JSON.stringify(result)
        )
      }

      await page.mouse.move(0, 0)
      await sleep(150)
    }

    /**
     * Enlarges the seeded session's own wrapper for the screenshot only — exactly the same
     * move as `e2e/suites/theme.mjs`'s `embiggenBlocksForScreenshot`, for the same reason: a
     * real few-second session renders as a sub-pixel-tall sliver at the grid's normal scale
     * (56px/hour in Day, 48px/hour in Week — see that suite's own comment on why this is
     * correct, not a bug), which is unreadable in a plain screenshot even though every real
     * check above already read its actual computed colours. Never touches product code, and
     * runs only after this view/tone's real checks are done.
     */
    async function embiggenSessionForScreenshot() {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        const wrapper = el?.parentElement
        if (wrapper instanceof HTMLElement) wrapper.style.height = '20px'
      }, SESSION)
    }

    async function screenshot(view, tone) {
      await embiggenSessionForScreenshot()
      await page.screenshot({ path: join(outDir, `timeline-layered-${view}-${tone}.png`) })
    }

    // ── light ───────────────────────────────────────────────────────────────────────────
    await page.evaluate(() => window.flowdo.settings.set({ theme: 'light' }))
    await sleep(300)
    await page.click('role=radio[name="Day"]')
    await sleep(500)
    await layeringChecks('day', 'light')
    await screenshot('day', 'light')

    await page.click('role=radio[name="Week"]')
    await sleep(500)
    await layeringChecks('week', 'light')
    await screenshot('week', 'light')

    // ── dark ────────────────────────────────────────────────────────────────────────────
    await page.evaluate(() => window.flowdo.settings.set({ theme: 'dark' }))
    await sleep(300)
    await page.click('role=radio[name="Day"]')
    await sleep(500)
    await layeringChecks('day', 'dark')
    await screenshot('day', 'dark')

    await page.click('role=radio[name="Week"]')
    await sleep(500)
    await layeringChecks('week', 'dark')
    await screenshot('week', 'dark')

    // ── Sync now: clicking it actually pulls a new calendar event ───────────────────────
    // Swaps the feed's served body for one with a fourth event (gamma/alpha/beta stay, so
    // the checks above are undisturbed by this running afterwards), then relies on "Sync
    // now" ALONE — never `calendars.refreshNow()` called directly, never a page reload —
    // to make it show up in the Day timeline.
    const DELTA_TITLE = 'Timeline E2E Delta'
    const deltaStart = now + 5 * MINUTE
    const deltaEnd = now + 20 * MINUTE
    setIcsBody(
      buildIcs([
        { uid: 'gamma', summary: GAMMA_TITLE, startMs: e3Start, endMs: e3End },
        { uid: 'alpha', summary: ALPHA_TITLE, startMs: e1Start, endMs: e1End },
        { uid: 'beta', summary: BETA_TITLE, startMs: e2Start, endMs: e2End },
        { uid: 'delta', summary: DELTA_TITLE, startMs: deltaStart, endMs: deltaEnd }
      ])
    )

    await page.click('[aria-label="Focus"]')
    await sleep(400)
    await page.click('button:has-text("Today")')
    await sleep(300)

    const syncButtonVisible = await page.isVisible('[data-testid="sync-now"]')
    check('"Sync now" is available on Today to trigger the check below', syncButtonVisible)

    if (syncButtonVisible) {
      await page.click('[data-testid="sync-now"]')
      const wentIdle = await waitFor(async () => {
        const busy = await page.getAttribute('[data-testid="sync-now"]', 'aria-busy')
        return busy === 'false'
      }, 8000)
      check('"Sync now" returns to idle (aria-busy="false") after a click', wentIdle)

      await page.click('[aria-label="Calendar"]')
      await sleep(500)
      await page.click('role=radio[name="Day"]')
      await sleep(500)
      const deltaSel = sel(DELTA_TITLE)
      const deltaVisible = await waitFor(async () => {
        await page.locator(deltaSel).scrollIntoViewIfNeeded().catch(() => {})
        return page.isVisible(deltaSel)
      }, 4000)
      check(
        'the event added via "Sync now" (not a page reload) appears in the Day timeline',
        deltaVisible
      )
    }

    // ── Sync now: screenshots ────────────────────────────────────────────────────────────
    await page.click('[aria-label="Focus"]')
    await sleep(300)
    await page.click('button:has-text("Today")')
    await sleep(300)
    await page.evaluate(() => window.flowdo.settings.set({ theme: 'light' }))
    await sleep(300)
    await page.screenshot({ path: join(outDir, 'today-sync-light.png') })
    await page.evaluate(() => window.flowdo.settings.set({ theme: 'dark' }))
    await sleep(300)
    await page.screenshot({ path: join(outDir, 'today-sync-dark.png') })

    // ── restore ─────────────────────────────────────────────────────────────────────────
    await page.evaluate(() => window.flowdo.settings.set({ theme: 'system' }))
    const restored = await page.evaluate(() => window.flowdo.settings.get())
    check('theme restored to system at the end of the suite', restored.theme === 'system', restored.theme)
  } finally {
    if (app) await quit(app)
    if (icsServer) await new Promise((r) => icsServer.close(r))
    if (secretService) secretService.cleanup()
    profile.cleanup()
  }

  return results
}
