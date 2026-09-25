#!/usr/bin/env node
/**
 * Flowdo's full e2e suite runner.
 *
 * Usage: node e2e/run.mjs [--app <path-to-executable>] [--no-minimize] [--only <suite>[,<suite>]]
 *
 * Without --app, every suite launches the unpackaged build (`electron .` against the built
 * `out/`, same as the old e2e/smoke.mjs). With --app, every suite launches that packaged
 * executable instead (release/win-unpacked/Flowdo.exe, an installed Flowdo.exe,
 * squashfs-root/flowdo from an extracted AppImage, /opt/Flowdo/flowdo from an extracted deb).
 *
 * Prints one `PASS|FAIL|SKIP  <suite> › <check> — detail` line per check, a summary, and
 * exits 1 on any FAIL.
 */

import { resolve } from 'node:path'

const ALL_SUITES = [
  'shell',
  'timer',
  'tasks',
  'calendar',
  'stats',
  'settings-persistence',
  'data',
  'mini',
  'theme',
  'updates',
  'platform'
]

function parseArgs(argv) {
  const opts = { appPath: null, checkMinimize: true, only: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--app') {
      opts.appPath = resolve(argv[++i])
    } else if (arg === '--no-minimize') {
      opts.checkMinimize = false
    } else if (arg === '--only') {
      opts.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      console.error(`e2e/run.mjs: unrecognised argument '${arg}'`)
      process.exit(2)
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const suiteNames = opts.only ?? ALL_SUITES

  const unknown = suiteNames.filter((s) => !ALL_SUITES.includes(s))
  if (unknown.length > 0) {
    console.error(`e2e/run.mjs: unknown suite(s): ${unknown.join(', ')}. Known: ${ALL_SUITES.join(', ')}`)
    process.exit(2)
  }

  console.log(
    `Running suites: ${suiteNames.join(', ')}${opts.appPath ? `\nTarget: ${opts.appPath}` : '\nTarget: unpackaged build'}`
  )

  const started = Date.now()
  const allResults = []

  for (const name of suiteNames) {
    const suiteStarted = Date.now()
    console.log(`\n── ${name} ──`)
    try {
      const mod = await import(`./suites/${name}.mjs`)
      const results = await mod.run({ appPath: opts.appPath, checkMinimize: opts.checkMinimize })
      allResults.push(...results)
    } catch (err) {
      console.error(`FAIL  ${name} › suite crashed — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      allResults.push({ suite: name, name: 'suite crashed', status: 'FAIL', detail: String(err) })
    }
    console.log(`(${name} took ${((Date.now() - suiteStarted) / 1000).toFixed(1)}s)`)
  }

  const pass = allResults.filter((r) => r.status === 'PASS').length
  const fail = allResults.filter((r) => r.status === 'FAIL').length
  const skip = allResults.filter((r) => r.status === 'SKIP').length
  const totalSeconds = ((Date.now() - started) / 1000).toFixed(1)

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped (${allResults.length} checks, ${totalSeconds}s)`)

  if (fail > 0) {
    console.log('\nFailed checks:')
    for (const r of allResults.filter((r) => r.status === 'FAIL')) {
      console.log(`  - ${r.suite} › ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
