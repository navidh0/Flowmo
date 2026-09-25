#!/usr/bin/env node
/**
 * Packaging drift checker.
 *
 * Usage: node e2e/drift.mjs <release-dir> [<release-dir> ...]
 *
 * For each release dir given (a local `release/` or a CI-downloaded artefact dir), checks
 * whatever artefacts are present and SKIPs whatever isn't — see the module's suite of
 * `check*` functions below for exactly what. Same PASS/FAIL/SKIP output style as e2e/run.mjs,
 * exits 1 on any FAIL.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { makeReporter, root } from './lib/harness.mjs'

const require = createRequire(import.meta.url)

// ─────────────────────────────────────────────────────────────────────────────
// Optional dependencies — never a hard failure. See the module's ownership note in the
// task: @electron/asar is used only if it resolves (a transitive dep of electron-builder);
// js-yaml the same. Either missing degrades to a SKIP line on the checks that need it.
// ─────────────────────────────────────────────────────────────────────────────

let asar = null
try {
  asar = require('@electron/asar')
} catch {
  asar = null
}

function tryRequireYaml() {
  try {
    return require('js-yaml')
  } catch {
    return null
  }
}
const yamlLib = tryRequireYaml()

/** Minimal fallback for electron-builder's flat latest*.yml shape, used only if js-yaml is
 *  unavailable. Handles top-level `key: value` and one `files:` list of `- key: value` maps. */
function parseSimpleYaml(text) {
  const out = {}
  const lines = text.split('\n')
  let currentList = null
  let currentItem = null
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.match(/^ */)[0].length
    const line = raw.trim()
    if (indent === 0) {
      const m = /^([\w-]+):\s*(.*)$/.exec(line)
      if (!m) continue
      const [, key, value] = m
      if (value === '' ) {
        currentList = []
        out[key] = currentList
        currentItem = null
      } else {
        out[key] = value.replace(/^['"]|['"]$/g, '')
        currentList = null
      }
      continue
    }
    if (line.startsWith('- ')) {
      currentItem = {}
      currentList?.push(currentItem)
      const rest = line.slice(2)
      const m = /^([\w-]+):\s*(.*)$/.exec(rest)
      if (m && currentItem) currentItem[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
      continue
    }
    const m = /^([\w-]+):\s*(.*)$/.exec(line)
    if (m && currentItem) currentItem[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

function loadYaml(text) {
  if (yamlLib) return yamlLib.load(text)
  return parseSimpleYaml(text)
}

function sha512Base64(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('base64')
}

function readPackageVersion() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
}

// ─────────────────────────────────────────────────────────────────────────────
// Desktop-entry parsing (shared by the .deb and AppImage checks).
// ─────────────────────────────────────────────────────────────────────────────

function parseDesktopEntry(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = /^([\w-]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

function findFileRecursive(dir, predicate) {
  if (!existsSync(dir)) return null
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (predicate(entry.name, full)) return full
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-artefact checks
// ─────────────────────────────────────────────────────────────────────────────

const ARTEFACT_PATTERNS = [
  { kind: 'nsis installer', re: /^Flowdo-Setup-(.+)\.exe$/ },
  { kind: 'portable exe', re: /^Flowdo-(.+)-portable\.exe$/ },
  { kind: 'AppImage', re: /^Flowdo-(.+)\.AppImage$/ },
  { kind: 'deb', re: /^flowdo_(.+)_amd64\.deb$/ }
]

function checkArtefactVersions(dir, files, pkgVersion, check) {
  let any = false
  for (const { kind, re } of ARTEFACT_PATTERNS) {
    const match = files.map((f) => re.exec(f)).find(Boolean)
    if (!match) continue
    any = true
    check(
      `${kind} filename version matches package.json (${pkgVersion})`,
      match[1] === pkgVersion,
      `${match[0]} → ${match[1]}`
    )
  }
  return any
}

function checkLatestYml(dir, files, pkgVersion, check, skip) {
  for (const ymlName of ['latest.yml', 'latest-linux.yml', 'latest-mac.yml']) {
    if (!files.includes(ymlName)) continue
    const ymlPath = join(dir, ymlName)
    let doc
    try {
      doc = loadYaml(readFileSync(ymlPath, 'utf-8'))
    } catch (err) {
      check(`${ymlName} parses`, false, String(err))
      continue
    }

    check(`${ymlName} version matches package.json`, doc.version === pkgVersion, `${doc.version} vs ${pkgVersion}`)

    const entries = Array.isArray(doc.files) ? doc.files : []
    if (doc.path && !entries.some((e) => e.url === doc.path)) {
      entries.push({ url: doc.path, sha512: doc.sha512, size: doc.size })
    }
    if (entries.length === 0) {
      skip(`${ymlName} files[] checked against real files`, 'no files[] entries')
      continue
    }
    for (const entry of entries) {
      const name = entry.url ?? entry.path
      const filePath = join(dir, name)
      if (!existsSync(filePath)) {
        check(`${ymlName}: ${name} exists in the release dir`, false, filePath)
        continue
      }
      check(`${ymlName}: ${name} exists in the release dir`, true)
      if (entry.sha512) {
        const actual = sha512Base64(filePath)
        check(`${ymlName}: ${name} sha512 matches`, actual === entry.sha512, `${actual} vs ${entry.sha512}`)
      }
      if (typeof entry.size === 'number') {
        const actualSize = statSync(filePath).size
        check(`${ymlName}: ${name} size matches`, actualSize === entry.size, `${actualSize} vs ${entry.size}`)
      }
    }
  }
}

function checkDeb(dir, files, pkgVersion, check, skip) {
  const debName = files.find((f) => /^flowdo_.+_amd64\.deb$/.test(f))
  if (!debName) {
    skip('deb package checks', 'no .deb in this release dir')
    return
  }
  const debPath = join(dir, debName)

  let fieldsOut = ''
  try {
    fieldsOut = execFileSync('dpkg-deb', ['-f', debPath], { encoding: 'utf-8' })
  } catch (err) {
    check('dpkg-deb -f runs', false, String(err))
    return
  }
  const fields = {}
  for (const line of fieldsOut.split('\n')) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line)
    if (m) fields[m[1]] = m[2].trim()
  }
  check('deb Package = flowdo', fields.Package === 'flowdo', fields.Package)
  check('deb Version matches package.json', fields.Version === pkgVersion, `${fields.Version} vs ${pkgVersion}`)
  check('deb Maintainer is present', !!fields.Maintainer && fields.Maintainer.length > 0, fields.Maintainer)
  check('deb Architecture = amd64', fields.Architecture === 'amd64', fields.Architecture)

  const extractDir = mkdtempSync(join(tmpdir(), 'flowdo-drift-deb-'))
  try {
    execFileSync('dpkg-deb', ['-x', debPath, extractDir])

    const desktopPath = findFileRecursive(extractDir, (name) => name === 'flowdo.desktop')
    if (!desktopPath) {
      check('deb contains a flowdo.desktop entry', false)
    } else {
      const entry = parseDesktopEntry(readFileSync(desktopPath, 'utf-8'))
      // electron-builder appends a standard freedesktop placeholder (` %U`) to Exec by
      // default when nothing overrides it (nothing does here — see electron-builder.yml's
      // own comment on why only StartupWMClass is overridden) — inert unless the app is
      // launched with a file/URL argument, so this is a prefix check, not exact equality.
      check(
        'deb .desktop Exec starts with /opt/Flowdo/flowdo',
        entry.Exec === '/opt/Flowdo/flowdo' || entry.Exec?.startsWith('/opt/Flowdo/flowdo '),
        entry.Exec
      )
      check('deb .desktop Icon=flowdo', entry.Icon === 'flowdo', entry.Icon)
      check('deb .desktop StartupWMClass=flowdo', entry.StartupWMClass === 'flowdo', entry.StartupWMClass)
      check('deb .desktop Name=Flowdo', entry.Name === 'Flowdo', entry.Name)
    }

    const appUpdatePath = findFileRecursive(extractDir, (name) => name === 'app-update.yml')
    if (!appUpdatePath) {
      check('deb resources/app-update.yml present', false)
    } else {
      const doc = loadYaml(readFileSync(appUpdatePath, 'utf-8'))
      check('deb app-update.yml provider = github', doc.provider === 'github', doc.provider)
      check('deb app-update.yml owner = navidh0', doc.owner === 'navidh0', doc.owner)
      check('deb app-update.yml repo = Flowmo', doc.repo === 'Flowmo', doc.repo)
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

function checkAppImage(dir, files, pkgVersion, check, skip) {
  const appImageName = files.find((f) => /^Flowdo-.+\.AppImage$/.test(f))
  if (!appImageName) {
    skip('AppImage checks', 'no .AppImage in this release dir')
    return
  }
  const appImagePath = join(dir, appImageName)

  const workDir = mkdtempSync(join(tmpdir(), 'flowdo-drift-appimage-'))
  try {
    try {
      execFileSync(appImagePath, ['--appimage-extract'], {
        cwd: workDir,
        env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '' }
      })
    } catch (err) {
      check('AppImage --appimage-extract runs', false, String(err))
      return
    }
    const squashfsRoot = join(workDir, 'squashfs-root')
    check('AppImage extracted a squashfs-root', existsSync(squashfsRoot))
    if (!existsSync(squashfsRoot)) return

    const desktopPath = findFileRecursive(squashfsRoot, (name) => name.endsWith('.desktop'))
    if (!desktopPath) {
      check('AppImage contains a .desktop entry', false)
    } else {
      const entry = parseDesktopEntry(readFileSync(desktopPath, 'utf-8'))
      check('AppImage .desktop Icon=flowdo', entry.Icon === 'flowdo', entry.Icon)
      check('AppImage .desktop StartupWMClass=flowdo', entry.StartupWMClass === 'flowdo', entry.StartupWMClass)
      check('AppImage .desktop Name=Flowdo', entry.Name === 'Flowdo', entry.Name)
    }

    const appUpdatePath = join(squashfsRoot, 'resources', 'app-update.yml')
    if (!existsSync(appUpdatePath)) {
      check('AppImage resources/app-update.yml present', false)
    } else {
      const doc = loadYaml(readFileSync(appUpdatePath, 'utf-8'))
      check('AppImage app-update.yml provider = github', doc.provider === 'github', doc.provider)
      check('AppImage app-update.yml owner = navidh0', doc.owner === 'navidh0', doc.owner)
      check('AppImage app-update.yml repo = Flowmo', doc.repo === 'Flowmo', doc.repo)
    }

    const asarPath = join(squashfsRoot, 'resources', 'app.asar')
    if (!existsSync(asarPath)) {
      check('AppImage embeds resources/app.asar', false)
    } else if (!asar) {
      skip('AppImage embedded app.asar package.json version', '@electron/asar not resolvable')
    } else {
      const pkgBuf = asar.extractFile(asarPath, 'package.json')
      const embeddedVersion = JSON.parse(pkgBuf.toString('utf-8')).version
      check(
        'AppImage embedded app.asar package.json version matches',
        embeddedVersion === pkgVersion,
        `${embeddedVersion} vs ${pkgVersion}`
      )
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform: only when both a Windows and a Linux unpacked build are present.
// ─────────────────────────────────────────────────────────────────────────────

function findUnpacked(dirs) {
  let win = null
  let linux = null
  for (const dir of dirs) {
    if (basename(dir) === 'win-unpacked') win = dir
    if (basename(dir) === 'linux-unpacked') linux = dir
    const w = join(dir, 'win-unpacked')
    const l = join(dir, 'linux-unpacked')
    if (!win && existsSync(w)) win = w
    if (!linux && existsSync(l)) linux = l
  }
  return { win, linux }
}

function checkCrossPlatform(allDirs, check, skip) {
  const { win, linux } = findUnpacked(allDirs)
  if (!win || !linux) {
    skip('cross-platform app.asar / electron version parity', 'need both win-unpacked and linux-unpacked to compare')
    return
  }

  const winAsar = join(win, 'resources', 'app.asar')
  const linuxAsar = join(linux, 'resources', 'app.asar')
  if (!existsSync(winAsar) || !existsSync(linuxAsar)) {
    check('both builds ship resources/app.asar', false, JSON.stringify({ win: existsSync(winAsar), linux: existsSync(linuxAsar) }))
  } else if (!asar) {
    skip('app.asar file-list parity', '@electron/asar not resolvable')
  } else {
    const winFiles = asar.listPackage(winAsar).sort()
    const linuxFiles = asar.listPackage(linuxAsar).sort()
    const same = JSON.stringify(winFiles) === JSON.stringify(linuxFiles)
    check('the same app code (app.asar file list) ships on both platforms', same, same ? '' : `win has ${winFiles.length} files, linux has ${linuxFiles.length}`)
  }

  // Electron version: only determinable by executing a binary this host can actually run.
  let linuxElectronVersion = null
  const linuxExe = findFileRecursive(linux, (name) => name === 'flowdo')
  if (linuxExe && process.platform === 'linux') {
    try {
      linuxElectronVersion = execFileSync(linuxExe, ['--version'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
        .toString('utf-8')
        .trim()
    } catch {
      linuxElectronVersion = null
    }
  }
  if (!linuxElectronVersion) {
    skip('electron version parity', 'could not determine the shipped Electron version by executing either binary on this host')
    return
  }
  const pkgElectron = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).devDependencies?.electron
  skip(
    'electron version parity (win side)',
    `cannot execute a Windows binary on ${process.platform} — linux side reports ${linuxElectronVersion}, both are built from devDependencies.electron ${pkgElectron}`
  )
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const dirs = process.argv.slice(2).map((d) => resolve(d))
  if (dirs.length === 0) {
    console.error('Usage: node e2e/drift.mjs <release-dir> [<release-dir> ...]')
    process.exit(2)
  }

  const { check, skip, results } = makeReporter('drift')
  const pkgVersion = readPackageVersion()

  for (const dir of dirs) {
    console.log(`\n── ${dir} ──`)
    if (!existsSync(dir)) {
      check(`${dir} exists`, false)
      continue
    }
    const files = readdirSync(dir)

    const anyArtefact = checkArtefactVersions(dir, files, pkgVersion, check)
    if (!anyArtefact) skip('artefact filename version checks', 'no recognised Flowdo artefact in this dir')

    checkLatestYml(dir, files, pkgVersion, check, skip)
    checkDeb(dir, files, pkgVersion, check, skip)
    checkAppImage(dir, files, pkgVersion, check, skip)
  }

  console.log(`\n── cross-platform ──`)
  checkCrossPlatform(dirs, check, skip)

  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skipped = results.filter((r) => r.status === 'SKIP').length
  console.log(`\n${'─'.repeat(40)}`)
  console.log(`${pass} passed, ${fail} failed, ${skipped} skipped (${results.length} checks)`)

  if (fail > 0) {
    console.log('\nFailed checks:')
    for (const r of results.filter((r) => r.status === 'FAIL')) {
      console.log(`  - ${r.suite} › ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
