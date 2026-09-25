#!/usr/bin/env node
/**
 * `npm run sweep` — mechanical enforcement of a handful of project invariants that used to
 * live only in CLAUDE.md/comments, so they stay true instead of merely remembered:
 *
 *   1. hex-colour   no hard-coded hex colours in the renderer outside the token file.
 *   2. fixed-width  no Tailwind `w-[…]` in components (panels are user-resizable).
 *   3. iso-date     no `toISOString()` in the renderer (local-day rule — ISO is UTC).
 *   4. layer-import main/renderer/preload/shared may not reach across process boundaries.
 *   5. attribution  (only with --commits) no AI attribution trailers in commit messages.
 *
 * Dependency-free, ESM, only touches git-tracked files (`git ls-files`) so build output and
 * node_modules are never in scope.
 *
 * CLI:
 *   node scripts/sweep.mjs                       scan the working tree
 *   node scripts/sweep.mjs --commits <git-range>  also check commit messages in that range
 *
 * Exit 0 clean, 1 violations found, 2 usage error. One line per violation:
 *   path:line  rule-id  message
 *
 * The logic below is exported as pure functions (`scanSource`, `checkCommitMessages`,
 * `applyAllowlist`, …) so `tests/sweep.test.ts` can exercise it directly without shelling
 * out. The CLI only runs when this file is executed directly — see the bottom guard.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST_PATH = path.join(ROOT, 'scripts', 'sweep-allowlist.json')

// ---------------------------------------------------------------------------------------
// Rule 1: hex-colour
// ---------------------------------------------------------------------------------------

/** The one file allowed to hold the raw hex values — everything else must reference it. */
const HEX_TOKENS_FILE = 'src/renderer/src/assets/index.css'

/**
 * Matches `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` only when the `#` sits where a colour
 * literal would (start of string/line, whitespace, a quote/backtick, `([{,:;=`) — never when
 * it's an HTML entity (`&#123;`, preceding char `&` is not in the allowed set), a CSS id
 * selector or URL-fragment whose text isn't itself all hex digits (`#/mini`, `#root`,
 * `#section-name` all fail immediately because the character(s) right after `#` aren't valid
 * hex), or a lone `'#'` (nothing follows to match the digit groups at all). The trailing
 * negative lookahead stops a 7- or 9-digit run from being read as a 6- or 8-digit colour.
 */
const HEX_COLOR_RE =
  /(^|[\s'"`([{,:;=])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g

function checkHexColour(file, content, out) {
  if (!file.startsWith('src/renderer/')) return
  if (file === HEX_TOKENS_FILE) return
  const ext = path.extname(file)
  if (ext !== '.ts' && ext !== '.tsx' && ext !== '.css') return

  forEachCodeLine(content, (line, lineNo) => {
    HEX_COLOR_RE.lastIndex = 0
    let m
    while ((m = HEX_COLOR_RE.exec(line))) {
      out.push({
        file,
        line: lineNo,
        rule: 'hex-colour',
        message: `hard-coded hex colour '#${m[2]}' — add/reuse a token in ${HEX_TOKENS_FILE} instead`,
        context: line
      })
    }
  })
}

// ---------------------------------------------------------------------------------------
// Rule 2: fixed-width
// ---------------------------------------------------------------------------------------

const COMPONENTS_DIR = 'src/renderer/src/components/'

/**
 * Matches Tailwind arbitrary-value widths (`w-[…]`) but never `min-w-[…]` or `max-w-[…]`
 * (the lookbehinds), and never `h-[…]` (there is no `w` in "h-[" for `\bw-\[` to find in the
 * first place, so no special case is needed there).
 */
const FIXED_WIDTH_RE = /(?<!min-)(?<!max-)\bw-\[[^\]]*\]/g

function checkFixedWidth(file, content, out) {
  if (!file.startsWith(COMPONENTS_DIR)) return
  const ext = path.extname(file)
  if (ext !== '.ts' && ext !== '.tsx') return

  forEachCodeLine(content, (line, lineNo) => {
    FIXED_WIDTH_RE.lastIndex = 0
    let m
    while ((m = FIXED_WIDTH_RE.exec(line))) {
      out.push({
        file,
        line: lineNo,
        rule: 'fixed-width',
        message: `Tailwind fixed width '${m[0]}' — panels are user-resizable; use flex/min-w, or allowlist with a reason`,
        context: line
      })
    }
  })
}

// ---------------------------------------------------------------------------------------
// Rule 3: iso-date
// ---------------------------------------------------------------------------------------

const ISO_DATE_RE = /toISOString\(/

function checkIsoDate(file, content, out) {
  if (!file.startsWith('src/renderer/')) return
  const ext = path.extname(file)
  if (ext !== '.ts' && ext !== '.tsx') return

  forEachCodeLine(content, (line, lineNo) => {
    if (ISO_DATE_RE.test(line)) {
      out.push({
        file,
        line: lineNo,
        rule: 'iso-date',
        message: "toISOString() reads local dates as UTC and can shift the day — use the local-day helpers instead",
        context: line
      })
    }
  })
}

// ---------------------------------------------------------------------------------------
// Rule 4: layer-import
// ---------------------------------------------------------------------------------------

/**
 * One `import` statement's module specifier, wherever it falls in the file — including
 * multi-line `import type {\n  A,\n  B\n} from '@shared/x'` blocks. The negative lookahead
 * inside the lazy `from`-search stops it from ever crossing into a *following* import
 * statement (so a side-effect import right before a normal one can't get its specifier
 * stolen), and side-effect-only imports (`import './x.css'`, no `from`) match too since the
 * whole from-clause is optional.
 */
const IMPORT_RE =
  /\bimport\s+(?:type\s+)?(?:(?:(?!\bimport\b)[\s\S])*?\bfrom\s+)?(['"])(?<specifier>[^'"]+)\1/g

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https', 'net',
  'os', 'path', 'process', 'sqlite', 'stream', 'string_decoder', 'timers', 'tls', 'url',
  'util', 'zlib'
])

function zoneOfPath(p) {
  if (p.startsWith('src/renderer/')) return 'renderer'
  if (p.startsWith('src/main/')) return 'main'
  if (p.startsWith('src/shared/')) return 'shared'
  if (p.startsWith('src/preload/')) return 'preload'
  return null
}

/** Resolves an import specifier (as written in `fromFile`) to the zone it points into. */
function resolveSpecifierZone(specifier, fromFile) {
  if (specifier === 'electron') return 'electron'
  if (specifier.startsWith('@shared/')) return 'shared'
  if (specifier.startsWith('@renderer/')) return 'renderer'
  if (specifier.startsWith('.')) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    return zoneOfPath(resolved) ?? 'other'
  }
  if (specifier.startsWith('node:')) return 'node-builtin'
  if (NODE_BUILTINS.has(specifier)) return 'node-builtin'
  return 'package'
}

const LAYER_RULES = {
  renderer: {
    forbidden: new Set(['main', 'electron']),
    describe: (zone) => `src/renderer/** must not import from ${zone === 'electron' ? "'electron'" : 'src/main/**'}`
  },
  main: {
    forbidden: new Set(['renderer']),
    describe: () => 'src/main/** must not import from src/renderer/**'
  },
  shared: {
    forbidden: new Set(['main', 'renderer', 'electron']),
    describe: (zone) =>
      `src/shared/** must not import from ${zone === 'electron' ? "'electron'" : `src/${zone}/**`}`
  },
  preload: {
    // preload is an allowlist, not a blocklist: anything other than electron/shared/itself/
    // node builtins is forbidden (npm packages included).
    allowed: new Set(['electron', 'shared', 'preload', 'node-builtin']),
    describe: (zone) =>
      `src/preload/** may only import 'electron', '@shared/*' and node builtins (got a ${zone} import)`
  }
}

function checkLayerImport(file, content, out) {
  const fileZone = zoneOfPath(file)
  if (!fileZone) return
  const ext = path.extname(file)
  if (ext !== '.ts' && ext !== '.tsx') return

  const rule = LAYER_RULES[fileZone]

  IMPORT_RE.lastIndex = 0
  let m
  while ((m = IMPORT_RE.exec(content))) {
    const specifier = m.groups.specifier
    const specZone = resolveSpecifierZone(specifier, file)
    const isViolation = rule.allowed ? !rule.allowed.has(specZone) : rule.forbidden.has(specZone)
    if (!isViolation) continue

    const lineNo = content.slice(0, m.index).split('\n').length
    const lineText = content.split('\n')[lineNo - 1] ?? m[0]
    out.push({
      file,
      line: lineNo,
      rule: 'layer-import',
      message: `${rule.describe(specZone)} (imports '${specifier}')`,
      context: lineText
    })
  }
}

// ---------------------------------------------------------------------------------------
// Rule 5: attribution (commit messages, --commits only)
// ---------------------------------------------------------------------------------------

/** Mirrors the local PreToolUse hook at .claude/hooks/no-attribution.js, plus the two extra
 *  markers this project also treats as attribution trailers (the robot emoji and a
 *  `Claude-Session:` trailer). Only the message BODY is ever checked — never the commit
 *  author, so `Claude <noreply@anthropic.com>` as an author is legitimate and untouched. */
const ATTRIBUTION_PATTERNS = [
  { id: 'co-authored-by', re: /co-authored-by:\s*.*\b(claude|anthropic)\b/i },
  { id: 'generated-with', re: /generated with \[?claude/i },
  { id: 'robot-emoji', re: /🤖/ },
  { id: 'claude-session', re: /claude-session:/i }
]

export function checkCommitMessages(commits) {
  const out = []
  for (const commit of commits) {
    for (const pattern of ATTRIBUTION_PATTERNS) {
      if (pattern.re.test(commit.message)) {
        out.push({
          file: `commit:${commit.hash.slice(0, 7)}`,
          line: 0,
          rule: 'attribution',
          message: `commit message carries an AI attribution marker (${pattern.id})`,
          context: commit.message
        })
      }
    }
  }
  return out
}

/** `git log --format=%H%x00%B%x01 <range>` output -> `{ hash, message }[]`. */
export function parseCommitLog(raw) {
  return raw
    .split('\x01')
    .map((record) => record.replace(/^\n/, '').trim())
    .filter(Boolean)
    .map((record) => {
      const nul = record.indexOf('\x00')
      const hash = nul === -1 ? record : record.slice(0, nul)
      const message = nul === -1 ? '' : record.slice(nul + 1)
      return { hash: hash.trim(), message: message.trim() }
    })
}

// ---------------------------------------------------------------------------------------
// Shared scanning helpers
// ---------------------------------------------------------------------------------------

/**
 * Calls `fn(line, 1-basedLineNumber)` for every line that isn't a comment line, so the three
 * source-text rules never flag their own documentation — e.g. the JSDoc lines in
 * `layout.ts`/`DailyChart.tsx` that say "never `toISOString()`", or the one in `WeekView.tsx`
 * that says "no `w-[…]`". This is line-based (doesn't parse `/* ... *\/` spans), which is
 * enough for this codebase's house style of `/**` block comments with `*`-prefixed
 * continuation lines and `//` line comments — a trailing same-line comment on real code is
 * not covered by this and would need an allowlist entry instead.
 */
function forEachCodeLine(content, fn) {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    fn(lines[i], i + 1)
  }
}

/** Runs every source rule applicable to `file` and returns the violations found in `content`. */
export function scanSource(file, content) {
  const out = []
  checkHexColour(file, content, out)
  checkFixedWidth(file, content, out)
  checkIsoDate(file, content, out)
  checkLayerImport(file, content, out)
  return out
}

// ---------------------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------------------

/** Throws with a usage-error-shaped message if `allowlist` isn't a well-formed entry array. */
export function validateAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) {
    throw new Error('sweep-allowlist.json must be a JSON array')
  }
  allowlist.forEach((entry, i) => {
    for (const key of ['rule', 'file', 'match', 'reason']) {
      if (typeof entry?.[key] !== 'string' || entry[key].length === 0) {
        throw new Error(`sweep-allowlist.json[${i}] is missing a non-empty "${key}"`)
      }
    }
  })
}

/**
 * Suppresses violations covered by the allowlist and reports entries that no longer match
 * anything as `stale-allowlist` violations, so the list can't quietly rot. An entry matches a
 * violation when their `rule` and `file` agree and the violation's source line (or, for a
 * commit violation, its message) contains the entry's `match` substring.
 */
export function applyAllowlist(violations, allowlist) {
  const usedEntries = new Set()
  const kept = []

  for (const violation of violations) {
    const entryIndex = allowlist.findIndex(
      (entry) =>
        entry.rule === violation.rule &&
        entry.file === violation.file &&
        violation.context.includes(entry.match)
    )
    if (entryIndex === -1) {
      kept.push(violation)
    } else {
      usedEntries.add(entryIndex)
    }
  }

  const stale = allowlist.filter((_, i) => !usedEntries.has(i))
  const staleViolations = stale.map((entry) => ({
    file: entry.file,
    line: 0,
    rule: 'stale-allowlist',
    message: `allowlist entry no longer matches anything (rule=${entry.rule}, match="${entry.match}") — remove it or fix it`,
    context: ''
  }))

  return { violations: [...kept, ...staleViolations], stale }
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function gitLsFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return []
  const raw = readFileSync(ALLOWLIST_PATH, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`scripts/sweep-allowlist.json is not valid JSON: ${err.message}`)
  }
  validateAllowlist(parsed)
  return parsed
}

function formatViolation(v) {
  return `${v.file}:${v.line}  ${v.rule}  ${v.message}`
}

class UsageError extends Error {}

function parseArgs(argv) {
  let commits = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--commits') {
      const value = argv[i + 1]
      if (!value) throw new UsageError('--commits requires a <git-range> argument')
      commits = value
      i++
    } else {
      throw new UsageError(`unknown argument: ${arg}`)
    }
  }
  return { commits }
}

function main() {
  let commitsRange
  try {
    ;({ commits: commitsRange } = parseArgs(process.argv.slice(2)))
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`usage: node scripts/sweep.mjs [--commits <git-range>]\n${err.message}`)
      process.exit(2)
    }
    throw err
  }

  let violations = []
  let filesScanned = 0

  try {
    const files = gitLsFiles()
    filesScanned = files.length
    for (const file of files) {
      const abs = path.join(ROOT, file)
      if (!existsSync(abs)) continue
      const content = readFileSync(abs, 'utf8')
      violations.push(...scanSource(file, content))
    }

    let commitsChecked = 0
    if (commitsRange) {
      const raw = execFileSync('git', ['log', '--format=%H%x00%B%x01', commitsRange], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
      })
      const commits = parseCommitLog(raw)
      commitsChecked = commits.length
      violations.push(...checkCommitMessages(commits))
    }

    const allowlist = loadAllowlist()
    const { violations: afterAllowlist } = applyAllowlist(violations, allowlist)
    violations = afterAllowlist

    violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule))

    for (const v of violations) console.log(formatViolation(v))

    if (violations.length === 0) {
      const commitsNote = commitsRange ? `, ${commitsChecked} commit(s)` : ''
      console.log(`sweep: clean (${filesScanned} file(s)${commitsNote})`)
      process.exit(0)
    } else {
      console.log(`sweep: ${violations.length} violation(s)`)
      process.exit(1)
    }
  } catch (err) {
    console.error(`sweep: ${err.message}`)
    process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
