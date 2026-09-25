#!/usr/bin/env node
/**
 * Packaging drift checker.
 *
 * Usage: node e2e/drift.mjs [--require-cross-platform] <release-dir> [<release-dir> ...]
 *
 * For each release dir given (a local `release/` or a CI-downloaded artefact dir), checks
 * whatever artefacts are present and SKIPs whatever isn't — see the module's suite of
 * `check*` functions below for exactly what. Same PASS/FAIL/SKIP output style as e2e/run.mjs,
 * exits 1 on any FAIL.
 *
 * The cross-platform app.asar comparison (see its own comment below) SKIPs rather than FAILs
 * when fewer than two dirs provide an asar to compare — normal for ci.yml, which only ever
 * has one platform's build on hand. Pass --require-cross-platform (release.yml does) to turn
 * that into a FAIL instead, for the one place both platforms' real release artefacts are
 * actually available side by side and the comparison has no excuse not to run.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
    // actions/upload-artifact + actions/download-artifact do not preserve the executable
    // bit, so a downloaded AppImage often isn't +x — and even when it already is, this
    // check has no business running the release artefact in place. Copy it into our own
    // scratch dir, chmod the copy, and extract from there; the input file itself is never
    // executed or mutated. APPIMAGE_EXTRACT_AND_RUN is explicitly unset (not just left
    // empty) so `--appimage-extract` actually just extracts rather than extract-and-run —
    // it needs no FUSE either way.
    const copyPath = join(workDir, appImageName)
    copyFileSync(appImagePath, copyPath)
    chmodSync(copyPath, 0o755)

    const extractEnv = { ...process.env }
    delete extractEnv.APPIMAGE_EXTRACT_AND_RUN
    try {
      execFileSync(copyPath, ['--appimage-extract'], {
        cwd: workDir,
        env: extractEnv
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
// Cross-platform: compares the app.asar shipped by every given release dir that has one.
//
// An asar is found in a dir either as `<something>-unpacked/resources/app.asar` (a local
// `release/` produced by `electron-builder --dir`-style unpacked output, e.g. ci.yml, which
// runs drift against a single platform's own `release/` where win-unpacked or
// linux-unpacked already sits) or as `app-*.asar` directly in the dir (release.yml's
// build-windows/build-linux jobs copy `resources/app.asar` out to `app-win.asar` /
// `app-linux.asar` specifically so this check has something to compare once the artefact
// only ever carries installers, never an unpacked tree).
//
// Note there's no Electron-version half to this check: the only way to read the Electron
// version a packaged build embeds is to execute that platform's binary, and a Linux runner
// can't execute a Windows one (nor the reverse) — so it can never be verified cross-platform
// here. Both platforms are built from the same devDependencies.electron in package-lock.json
// already, which is what actually pins that parity; this check is named for only the half it
// can actually verify.
// ─────────────────────────────────────────────────────────────────────────────

function findAsarInDir(dir) {
  if (!existsSync(dir)) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.endsWith('-unpacked')) {
      const p = join(dir, entry.name, 'resources', 'app.asar')
      if (existsSync(p)) return p
    }
  }
  const direct = entries.find((entry) => entry.isFile() && /^app-.+\.asar$/.test(entry.name))
  return direct ? join(dir, direct.name) : null
}

function checkCrossPlatform(allDirs, check, skip, requireCrossPlatform) {
  const suite = 'cross-platform app.asar parity'
  // A missing comparison is a SKIP by default (nothing to compare against yet is not a
  // packaging defect on its own), but --require-cross-platform promotes that to a FAIL —
  // for release.yml, where both platforms' artefacts are always expected side by side and a
  // silent SKIP would mean the one check that exists specifically for the release never ran.
  const cannotCompare = (detail) => {
    if (requireCrossPlatform) check(suite, false, detail)
    else skip(suite, detail)
  }

  const found = allDirs.map((dir) => ({ dir, asarPath: findAsarInDir(dir) })).filter((entry) => entry.asarPath)

  if (found.length < 2) {
    cannotCompare(
      allDirs.length < 2
        ? 'fewer than two release dirs given to compare'
        : 'need an app.asar (as *-unpacked/resources/app.asar, or app-*.asar) in at least two release dirs to compare'
    )
    return
  }
  if (!asar) {
    cannotCompare('@electron/asar not resolvable')
    return
  }

  const [reference, ...others] = found
  const referenceFiles = asar.listPackage(reference.asarPath).sort()
  const referenceSet = new Set(referenceFiles)

  let firstListDiff = null
  let firstContentDiff = null

  for (const other of others) {
    const otherFiles = asar.listPackage(other.asarPath).sort()
    const otherSet = new Set(otherFiles)

    if (!firstListDiff) {
      const onlyInReference = referenceFiles.find((f) => !otherSet.has(f))
      const onlyInOther = onlyInReference ? undefined : otherFiles.find((f) => !referenceSet.has(f))
      const diffPath = onlyInReference ?? onlyInOther
      if (diffPath) {
        firstListDiff = `${diffPath} is present in ${onlyInReference ? reference.dir : other.dir} but not ${onlyInReference ? other.dir : reference.dir}`
      }
    }

    if (!firstContentDiff) {
      for (const f of referenceFiles) {
        if (!otherSet.has(f)) continue // already surfaced as a list diff above
        // listPackage()'s paths are asar-root-absolute ("/node_modules/..."); passing that
        // leading slash straight to extractFile/statFile trips a path-splitting quirk in
        // @electron/asar's own directory traversal (an empty leading segment from
        // '/x'.split('/') corrupts its lookup), so it must be stripped first.
        const relPath = f.startsWith('/') ? f.slice(1) : f
        let a
        let b
        try {
          a = asar.extractFile(reference.asarPath, relPath)
          b = asar.extractFile(other.asarPath, relPath)
        } catch (err) {
          // Directories and symlinks list like files but can't be extracted — they're
          // already covered by the file-list comparison above, so skip rather than FAIL.
          if (/found a directory or link/.test(String(err))) continue
          firstContentDiff = `${f}: could not extract from both asars — ${err}`
          break
        }
        if (!a.equals(b)) {
          const hashA = createHash('sha256').update(a).digest('hex')
          const hashB = createHash('sha256').update(b).digest('hex')
          firstContentDiff = `${f} differs: ${reference.dir} is ${hashA.slice(0, 12)}, ${other.dir} is ${hashB.slice(0, 12)}`
          break
        }
      }
    }

    if (firstListDiff && firstContentDiff) break
  }

  check('app.asar file list is identical across platforms', !firstListDiff, firstListDiff ?? '')
  check('app.asar file contents are identical across platforms', !firstContentDiff, firstContentDiff ?? '')
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2)
  const requireCrossPlatform = rawArgs.includes('--require-cross-platform')
  const dirs = rawArgs.filter((a) => a !== '--require-cross-platform').map((d) => resolve(d))
  if (dirs.length === 0) {
    console.error('Usage: node e2e/drift.mjs [--require-cross-platform] <release-dir> [<release-dir> ...]')
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
  checkCrossPlatform(dirs, check, skip, requireCrossPlatform)

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
