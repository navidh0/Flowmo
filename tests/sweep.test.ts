/**
 * Independent check on scripts/sweep.mjs.
 *
 * One failing + one passing case per rule, the false-positive traps the hex-colour and
 * comment-skipping logic exist for, allowlist suppression, stale-allowlist detection, and
 * the attribution check on synthetic commit messages. Fixtures are kept inline — nothing
 * here reads the real tree, so this suite stays true even as the app's own files change.
 */

import { describe, expect, it } from 'vitest'
import {
  applyAllowlist,
  checkCommitMessages,
  parseCommitLog,
  scanSource,
  validateAllowlist,
  type AllowlistEntry,
  type CommitRecord,
  type Violation
} from '../scripts/sweep.mjs'

function rulesOf(violations: Violation[]): string[] {
  return violations.map((v) => v.rule)
}

// ---------------------------------------------------------------------------------------
// hex-colour
// ---------------------------------------------------------------------------------------

describe('hex-colour', () => {
  const FILE = 'src/renderer/src/components/widget/Thing.tsx'

  it('flags a hard-coded hex colour in a renderer component', () => {
    const violations = scanSource(FILE, `export const cls = 'text-[#0a0d12]'\n`)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'hex-colour', line: 1 })
    expect(violations[0]?.message).toContain('#0a0d12')
  })

  it('passes when the colour comes from a CSS var token', () => {
    const violations = scanSource(FILE, `export const cls = 'text-[var(--color-on-accent)]'\n`)
    expect(violations.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
  })

  it('is skipped entirely for the token file itself', () => {
    const violations = scanSource(
      'src/renderer/src/assets/index.css',
      `:root { --color-focus: #6366f1; }\n`
    )
    expect(violations.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
  })

  it('does not flag a hash route (non-hex text after #)', () => {
    const violations = scanSource(FILE, `const isMini = location.hash.startsWith('#/mini')\n`)
    expect(violations.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
  })

  it('does not flag an HTML numeric entity', () => {
    const violations = scanSource(FILE, `const html = 'A&#39;s file'\n`)
    expect(violations.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
  })

  it('does not flag a CSS id selector', () => {
    const violations = scanSource(FILE.replace('.tsx', '.css'), `html, body, #root { height: 100%; }\n`)
    expect(violations.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
  })

  it('does not flag a lone "#" string', () => {
    const violations = scanSource(FILE, `const href = '#'\n`)
    expect(violations.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
  })

  it('does not flag a mention of a hex colour inside a comment', () => {
    const violations = scanSource(
      FILE,
      `/**\n * Never hard-code #0a0d12 here, use the token instead.\n */\nexport const x = 1\n`
    )
    expect(violations.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
  })

  it('only applies under src/renderer/**', () => {
    const violations = scanSource('src/main/foo.ts', `const c = '#0a0d12'\n`)
    expect(violations.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------
// fixed-width
// ---------------------------------------------------------------------------------------

describe('fixed-width', () => {
  const FILE = 'src/renderer/src/components/widget/Thing.tsx'

  it('flags a Tailwind fixed width in a component', () => {
    const violations = scanSource(FILE, `const cls = 'w-[320px] rounded-xl'\n`)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'fixed-width', line: 1 })
    expect(violations[0]?.message).toContain('w-[320px]')
  })

  it('passes for min-w-[...], max-w-[...] and h-[...] (all false-positive traps)', () => {
    const violations = scanSource(
      FILE,
      `const cls = 'min-w-[320px] max-w-[480px] h-[7px] flex-1'\n`
    )
    expect(violations.filter((v) => v.rule === 'fixed-width')).toHaveLength(0)
  })

  it('does not flag a mention of w-[...] inside a comment', () => {
    const violations = scanSource(
      FILE,
      `/**\n * Columns flex; never fixed with \`w-[…]\` on them.\n */\nconst cls = 'flex-1'\n`
    )
    expect(violations.filter((v) => v.rule === 'fixed-width')).toHaveLength(0)
  })

  it('only applies under src/renderer/src/components/**', () => {
    const violations = scanSource('src/renderer/src/stores/tasks.ts', `const cls = 'w-[320px]'\n`)
    expect(violations.filter((v) => v.rule === 'fixed-width')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------
// iso-date
// ---------------------------------------------------------------------------------------

describe('iso-date', () => {
  const FILE = 'src/renderer/src/components/widget/Thing.tsx'

  it('flags toISOString() in a renderer file', () => {
    const violations = scanSource(FILE, `const key = someDate.toISOString()\n`)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'iso-date', line: 1 })
  })

  it('passes for the local-day helper pattern', () => {
    const violations = scanSource(
      FILE,
      `const key = \`\${y}-\${String(m).padStart(2, '0')}-\${String(d).padStart(2, '0')}\`\n`
    )
    expect(violations.filter((v) => v.rule === 'iso-date')).toHaveLength(0)
  })

  it('does not flag toISOString() mentioned only in a comment', () => {
    const violations = scanSource(
      FILE,
      `/**\n * Never \`toISOString()\` here — that is UTC and can shift the day.\n */\nexport const x = 1\n`
    )
    expect(violations.filter((v) => v.rule === 'iso-date')).toHaveLength(0)
  })

  it('only applies under src/renderer/**', () => {
    const violations = scanSource('src/main/dataio.ts', `const key = d.toISOString()\n`)
    expect(violations.filter((v) => v.rule === 'iso-date')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------
// layer-import
// ---------------------------------------------------------------------------------------

describe('layer-import', () => {
  it('flags src/renderer/** importing from src/main/**', () => {
    const violations = scanSource(
      'src/renderer/src/stores/tasks.ts',
      `import { openDb } from '../../../main/db'\n`
    )
    expect(rulesOf(violations)).toContain('layer-import')
  })

  it('flags src/renderer/** importing "electron" directly', () => {
    const violations = scanSource(
      'src/renderer/src/stores/tasks.ts',
      `import { ipcRenderer } from 'electron'\n`
    )
    expect(rulesOf(violations)).toContain('layer-import')
  })

  it('flags an `import type` from src/main/** in the renderer too', () => {
    const violations = scanSource(
      'src/renderer/src/stores/tasks.ts',
      `import type { Thing } from '../../../main/db'\n`
    )
    expect(rulesOf(violations)).toContain('layer-import')
  })

  it('flags src/main/** importing from src/renderer/**', () => {
    const violations = scanSource(
      'src/main/db/index.ts',
      `import { useTasksStore } from '../../renderer/src/stores/tasks'\n`
    )
    expect(rulesOf(violations)).toContain('layer-import')
  })

  it('flags src/shared/** importing from src/main, src/renderer or electron', () => {
    const fromMain = scanSource('src/shared/types.ts', `import { x } from '../main/db'\n`)
    const fromRenderer = scanSource(
      'src/shared/types.ts',
      `import { x } from '../renderer/src/stores/tasks'\n`
    )
    const fromElectron = scanSource('src/shared/types.ts', `import { app } from 'electron'\n`)
    expect(rulesOf(fromMain)).toContain('layer-import')
    expect(rulesOf(fromRenderer)).toContain('layer-import')
    expect(rulesOf(fromElectron)).toContain('layer-import')
  })

  it('flags src/preload/** importing an npm package outside its allowlist', () => {
    const violations = scanSource('src/preload/index.ts', `import { create } from 'zustand'\n`)
    expect(rulesOf(violations)).toContain('layer-import')
  })

  it('flags src/preload/** importing from src/renderer/**', () => {
    const violations = scanSource(
      'src/preload/index.ts',
      `import { useTasksStore } from '@renderer/stores/tasks'\n`
    )
    expect(rulesOf(violations)).toContain('layer-import')
  })

  it('passes for src/preload/** importing electron, @shared/* and node builtins', () => {
    const violations = scanSource(
      'src/preload/index.ts',
      [
        `import { contextBridge, ipcRenderer } from 'electron'`,
        `import type { IpcRendererEvent } from 'electron'`,
        `import { CH } from '@shared/channels'`,
        `import { randomUUID } from 'node:crypto'`,
        ''
      ].join('\n')
    )
    expect(violations.filter((v) => v.rule === 'layer-import')).toHaveLength(0)
  })

  it('passes for a multi-line `import type { ... } from` block', () => {
    const violations = scanSource(
      'src/preload/index.ts',
      [
        `import type {`,
        `  FlowdoApi,`,
        `  HotkeyFailure`,
        `} from '@shared/types'`,
        ''
      ].join('\n')
    )
    expect(violations.filter((v) => v.rule === 'layer-import')).toHaveLength(0)
  })

  it('passes for a side-effect-only import and ordinary same-zone/npm imports', () => {
    const violations = scanSource(
      'src/renderer/src/App.tsx',
      [
        `import './assets/index.css'`,
        `import { useState } from 'react'`,
        `import { useTasksStore } from '@renderer/stores/tasks'`,
        `import { DEFAULT_SETTINGS } from '@shared/types'`,
        ''
      ].join('\n')
    )
    expect(violations.filter((v) => v.rule === 'layer-import')).toHaveLength(0)
  })

  it('does not let a lazily-matched import statement steal a later one\'s specifier', () => {
    const violations = scanSource(
      'src/renderer/src/App.tsx',
      [
        `import './assets/index.css'`,
        `import { app } from 'electron'`,
        ''
      ].join('\n')
    )
    // The side-effect import above must not swallow the electron import's `from` clause —
    // the electron import must still be caught.
    expect(violations.filter((v) => v.rule === 'layer-import')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------
// allowlist: suppression + stale detection
// ---------------------------------------------------------------------------------------

describe('applyAllowlist', () => {
  const FILE = 'src/renderer/src/components/widget/Palette.tsx'

  it('suppresses a violation whose line contains the entry\'s match', () => {
    const violations = scanSource(FILE, `const SWATCHES = ['#6366f1', '#22c55e']\n`)
    expect(violations.length).toBeGreaterThan(0)

    const allowlist: AllowlistEntry[] = [
      { rule: 'hex-colour', file: FILE, match: 'SWATCHES', reason: 'user colour data' }
    ]
    const { violations: kept, stale } = applyAllowlist(violations, allowlist)
    expect(kept.filter((v) => v.rule === 'hex-colour')).toHaveLength(0)
    expect(stale).toHaveLength(0)
  })

  it('does not suppress a violation in a different file or under a different rule', () => {
    const violations = scanSource(FILE, `const cls = 'text-[#0a0d12]'\n`)
    const wrongFile: AllowlistEntry[] = [
      { rule: 'hex-colour', file: 'src/renderer/src/other.tsx', match: '#0a0d12', reason: 'x' }
    ]
    const wrongRule: AllowlistEntry[] = [
      { rule: 'fixed-width', file: FILE, match: '#0a0d12', reason: 'x' }
    ]
    // Neither entry applies to this violation, so it stays — and since neither entry ever
    // matched anything either, each also comes back as its own stale-allowlist violation.
    const byWrongFile = applyAllowlist(violations, wrongFile).violations
    const byWrongRule = applyAllowlist(violations, wrongRule).violations
    expect(byWrongFile.filter((v) => v.rule === 'hex-colour')).toHaveLength(1)
    expect(byWrongFile.filter((v) => v.rule === 'stale-allowlist')).toHaveLength(1)
    expect(byWrongRule.filter((v) => v.rule === 'hex-colour')).toHaveLength(1)
    expect(byWrongRule.filter((v) => v.rule === 'stale-allowlist')).toHaveLength(1)
  })

  it('reports an allowlist entry that matches nothing as stale-allowlist', () => {
    const { violations: kept, stale } = applyAllowlist([], [
      { rule: 'hex-colour', file: FILE, match: '#dead00', reason: 'no longer present' }
    ])
    expect(stale).toHaveLength(1)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.rule).toBe('stale-allowlist')
    expect(kept[0]?.message).toContain('#dead00')
  })

  it('a still-matching entry is not reported as stale', () => {
    const violations = scanSource(FILE, `const cls = 'text-[#0a0d12]'\n`)
    const allowlist: AllowlistEntry[] = [
      { rule: 'hex-colour', file: FILE, match: '#0a0d12', reason: 'x' }
    ]
    const { stale } = applyAllowlist(violations, allowlist)
    expect(stale).toHaveLength(0)
  })
})

describe('validateAllowlist', () => {
  it('accepts a well-formed allowlist', () => {
    expect(() =>
      validateAllowlist([{ rule: 'hex-colour', file: 'a.ts', match: 'x', reason: 'because' }])
    ).not.toThrow()
  })

  it('rejects an entry missing a non-empty reason', () => {
    expect(() =>
      validateAllowlist([{ rule: 'hex-colour', file: 'a.ts', match: 'x', reason: '' }])
    ).toThrow()
  })

  it('rejects a non-array allowlist', () => {
    expect(() => validateAllowlist({})).toThrow()
  })
})

// ---------------------------------------------------------------------------------------
// attribution (commit messages)
// ---------------------------------------------------------------------------------------

describe('checkCommitMessages', () => {
  function commit(message: string): CommitRecord {
    return { hash: '0123456789abcdef0123456789abcdef01234567', message }
  }

  it('passes a clean commit message', () => {
    const violations = checkCommitMessages([commit('Fix midnight-wrap ordering in Today view')])
    expect(violations).toHaveLength(0)
  })

  it('flags a Co-Authored-By trailer naming Claude', () => {
    const violations = checkCommitMessages([
      commit('Fix bug\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>')
    ])
    expect(rulesOf(violations)).toContain('attribution')
  })

  it('flags a "Generated with [Claude Code]" marker', () => {
    const violations = checkCommitMessages([
      commit('Fix bug\n\nGenerated with [Claude Code](https://claude.com/claude-code)')
    ])
    expect(rulesOf(violations)).toContain('attribution')
  })

  it('flags the robot emoji marker', () => {
    const violations = checkCommitMessages([commit('Fix bug\n\n🤖 shipped by an agent')])
    expect(rulesOf(violations)).toContain('attribution')
  })

  it('flags a Claude-Session trailer', () => {
    const violations = checkCommitMessages([
      commit('Fix bug\n\nClaude-Session: https://claude.ai/code/session_abc123')
    ])
    expect(rulesOf(violations)).toContain('attribution')
  })

  it('does not flag a commit whose AUTHOR is Claude but whose message is clean', () => {
    // checkCommitMessages only ever receives the message body (git log %B) — author identity
    // never reaches it, so "Claude <noreply@anthropic.com>" as an author is untouched here.
    const violations = checkCommitMessages([commit('Release 0.4.0')])
    expect(violations).toHaveLength(0)
  })
})

describe('parseCommitLog', () => {
  it('splits git log --format=%H%x00%B%x01 output into hash/message records', () => {
    const raw = 'aaa111\x00First commit\n\nBody line\x01\nbbb222\x00Second commit\x01'
    const commits = parseCommitLog(raw)
    expect(commits).toEqual([
      { hash: 'aaa111', message: 'First commit\n\nBody line' },
      { hash: 'bbb222', message: 'Second commit' }
    ])
  })

  it('returns an empty array for an empty range', () => {
    expect(parseCommitLog('')).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------
// CRLF sources (Windows checkout) — a real regression: `content.split('\n')` used to leave
// every line ending in a stray '\r', and line numbers/violation text were wrong past line 1.
// ---------------------------------------------------------------------------------------

describe('CRLF sources', () => {
  const FILE = 'src/renderer/src/components/widget/Thing.tsx'

  it('finds a hex-colour violation on the right line when the file is CRLF', () => {
    const crlf = `const a = 1\r\nconst cls = 'text-[#0a0d12]'\r\nconst b = 2\r\n`
    const violations = scanSource(FILE, crlf)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'hex-colour', line: 2 })
    // The captured line/context must not carry a trailing '\r' into the match.
    expect(violations[0]?.context.endsWith('\r')).toBe(false)
  })

  it('finds a fixed-width violation on the right line when the file is CRLF', () => {
    const crlf = `const a = 1\r\nconst b = 2\r\nconst cls = 'w-[320px]'\r\n`
    const violations = scanSource(FILE, crlf)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'fixed-width', line: 3 })
  })

  it('still skips a CRLF comment line for iso-date', () => {
    const crlf = `/**\r\n * never toISOString() here\r\n */\r\nexport const x = 1\r\n`
    expect(scanSource(FILE, crlf).filter((v) => v.rule === 'iso-date')).toHaveLength(0)
  })

  it('reports the right line number for a layer-import violation when the file is CRLF', () => {
    const crlf = `import { useState } from 'react'\r\nimport { app } from 'electron'\r\n`
    const violations = scanSource('src/renderer/src/App.tsx', crlf)
    const layerViolations = violations.filter((v) => v.rule === 'layer-import')
    expect(layerViolations).toHaveLength(1)
    expect(layerViolations[0]).toMatchObject({ line: 2 })
    expect(layerViolations[0]?.context.endsWith('\r')).toBe(false)
  })
})
