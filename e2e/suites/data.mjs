/**
 * data — export → wipe → import round trip, with the save/open dialogs stubbed in the main
 * process (never real dialogs), checked against dataio.ts's actual contract: exportJson()/
 * importJson() take no arguments, importJson writes a `flowdo-backup-*.db` before replacing.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { launch, quit, makeProfile, makeReporter, outDir, sleep } from '../lib/harness.mjs'

const SUSPICIOUS_KEYS = /"(token|secret|password|apikey|api_key|accesstoken|access_token)"\s*:/i

export async function run() {
  const { check, results } = makeReporter('data')
  const profile = makeProfile('flowdo-e2e-data-')
  const exportPath = join(outDir, `data-roundtrip-${Date.now()}.json`)

  let app
  try {
    const launched = await launch({ profile })
    app = launched.app
    const page = launched.page

    const project = await page.evaluate(() => window.flowdo.projects.create({ name: 'Round-trip project' }))
    const task = await page.evaluate(
      ({ projectId }) => window.flowdo.tasks.create({ projectId, title: 'Round-trip task' }),
      { projectId: project.id }
    )
    await page.evaluate(() => window.flowdo.timer.setMode('flowmodoro', 'discard'))
    await page.evaluate(() => window.flowdo.timer.start())
    await new Promise((r) => setTimeout(r, 1200))
    await page.evaluate(() => window.flowdo.timer.stop())

    // Settings distinct from the defaults, so restoring them from the export is actually
    // observable (round-tripping an unchanged default would prove nothing).
    const settingsBeforeExport = await page.evaluate(() =>
      window.flowdo.settings.set({ theme: 'dark', weekStartsOn: 0 })
    )

    const before = {
      projects: await page.evaluate(() => window.flowdo.projects.list()),
      tasks: await page.evaluate(() => window.flowdo.tasks.list()),
      sessions: await page.evaluate(() => window.flowdo.sessions.recent(50))
    }
    // Exactly 2 projects: the migration-seeded "Inbox" plus the one created above.
    check(
      'seed data present before export (exact counts)',
      before.projects.length === 2 && before.tasks.length === 1 && before.sessions.length === 1,
      JSON.stringify({ projects: before.projects.length, tasks: before.tasks.length, sessions: before.sessions.length })
    )

    // ── Export, dialog stubbed ────────────────────────────────────────────────
    await app.evaluate(
      ({ dialog }, p) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
      },
      exportPath
    )
    const exportResult = await page.evaluate(() => window.flowdo.data.exportJson())
    check(
      'exportJson() writes a file and reports the session count',
      exportResult.path === exportPath && exportResult.sessions === before.sessions.length,
      JSON.stringify(exportResult)
    )
    check('the exported file exists on disk', existsSync(exportPath))

    const exportedRaw = existsSync(exportPath) ? readFileSync(exportPath, 'utf-8') : ''
    check('exported JSON contains no credential/token material', !SUSPICIOUS_KEYS.test(exportedRaw))
    const exported = exportedRaw ? JSON.parse(exportedRaw) : null
    check(
      'exported JSON has the versioned ExportFile shape',
      exported?.version === 1 && Array.isArray(exported?.projects) && Array.isArray(exported?.sessions)
    )

    // ── Wipe ───────────────────────────────────────────────────────────────────
    for (const p of before.projects) {
      await page.evaluate((id) => window.flowdo.projects.remove(id), p.id)
    }
    for (const s of before.sessions) {
      await page.evaluate((id) => window.flowdo.sessions.remove(id), s.id)
    }
    // Also diverge settings from what was exported — otherwise "settings come back" below
    // would trivially pass even if import never touched settings at all.
    await page.evaluate(() => window.flowdo.settings.set({ theme: 'light', weekStartsOn: 1 }))
    const wiped = {
      projects: await page.evaluate(() => window.flowdo.projects.list()),
      sessions: await page.evaluate(() => window.flowdo.sessions.recent(50)),
      settings: await page.evaluate(() => window.flowdo.settings.get())
    }
    check(
      'data is wiped and settings diverged before import',
      wiped.projects.length === 0 &&
        wiped.sessions.length === 0 &&
        wiped.settings.theme === 'light' &&
        wiped.settings.weekStartsOn === 1,
      JSON.stringify(wiped)
    )

    // ── Import, dialog stubbed ────────────────────────────────────────────────
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    const backupsBefore = readdirSync(userData).filter((f) => f.startsWith('flowdo-backup-'))

    await app.evaluate(
      ({ dialog }, p) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
      },
      exportPath
    )
    // A successful import makes main reload BOTH renderers (dataio.ts / index.ts's
    // reloadAfterImport) so every store re-reads the replaced data — that reload can destroy
    // this very evaluate call's execution context before Playwright reads back the resolved
    // value, so the throw here is expected and the effects are checked below instead.
    let importThrew = false
    try {
      await page.evaluate(() => window.flowdo.data.importJson())
    } catch {
      importThrew = true
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await sleep(1200)
    console.log(
      `      (importJson()'s own evaluate call ${importThrew ? 'was destroyed by the post-import reload, as documented' : 'resolved normally'}; verified below via its actual effects)`
    )

    const backupsAfter = readdirSync(userData).filter((f) => f.startsWith('flowdo-backup-'))
    check(
      'a flowdo-backup-*.db was written before the replace',
      backupsAfter.length === backupsBefore.length + 1,
      JSON.stringify({ before: backupsBefore, after: backupsAfter })
    )

    const after = {
      projects: await page.evaluate(() => window.flowdo.projects.list()),
      tasks: await page.evaluate(() => window.flowdo.tasks.list()),
      sessions: await page.evaluate(() => window.flowdo.sessions.recent(50)),
      settings: await page.evaluate(() => window.flowdo.settings.get())
    }
    check(
      'projects/tasks/sessions come back after import (exact counts and content)',
      after.projects.length === before.projects.length &&
        after.tasks.length === before.tasks.length &&
        after.tasks[0]?.title === task.title &&
        after.sessions.length === before.sessions.length &&
        after.sessions[0]?.id === before.sessions[0]?.id,
      JSON.stringify({ projects: after.projects.length, tasks: after.tasks.length, sessions: after.sessions.length })
    )
    // The settings baked into the export (theme=dark, weekStartsOn=0) must overwrite the
    // divergent post-wipe values (theme=light, weekStartsOn=1) set above — not just "some
    // settings object exists".
    check(
      'settings are restored to the exported values, not left at the pre-import (diverged) ones',
      after.settings.theme === settingsBeforeExport.theme &&
        after.settings.weekStartsOn === settingsBeforeExport.weekStartsOn &&
        after.settings.theme === 'dark' &&
        after.settings.weekStartsOn === 0,
      JSON.stringify({ theme: after.settings.theme, weekStartsOn: after.settings.weekStartsOn })
    )
  } finally {
    if (app) await quit(app)
    profile.cleanup()
    if (existsSync(exportPath)) unlinkSync(exportPath)
  }

  return results
}
