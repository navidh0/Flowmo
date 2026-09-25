/**
 * Tests for `src/main/autostart.ts`. No Electron involved — `AutostartDeps` is passed in
 * directly, pointed at a fresh temp directory standing in for `$HOME` per test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  desktopEntry,
  isLinuxAutostartEnabled,
  quoteExecArg,
  setLinuxAutostart,
  type AutostartDeps
} from '../src/main/autostart'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'flowdo-autostart-test-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function deps(overrides: Partial<AutostartDeps> = {}): AutostartDeps {
  return { homeDir: home, execPath: '/usr/lib/flowdo/flowdo', ...overrides }
}

function autostartFile(baseHome = home, xdgConfigHome?: string): string {
  const configHome = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(baseHome, '.config')
  return join(configHome, 'autostart', 'flowdo.desktop')
}

describe('write / remove / idempotence', () => {
  it('enabling writes ~/.config/autostart/flowdo.desktop', () => {
    setLinuxAutostart(true, deps())
    expect(existsSync(autostartFile())).toBe(true)
  })

  it('the written file contains the expected Desktop Entry keys', () => {
    setLinuxAutostart(true, deps())
    const contents = readFileSync(autostartFile(), 'utf-8')
    expect(contents).toContain('[Desktop Entry]')
    expect(contents).toContain('Type=Application')
    expect(contents).toContain('Name=Flowdo')
    expect(contents).toContain('Exec=/usr/lib/flowdo/flowdo')
    expect(contents).toContain('X-GNOME-Autostart-enabled=true')
    expect(contents).toContain('Terminal=false')
  })

  it('disabling removes the file', () => {
    setLinuxAutostart(true, deps())
    expect(existsSync(autostartFile())).toBe(true)

    setLinuxAutostart(false, deps())
    expect(existsSync(autostartFile())).toBe(false)
  })

  it('disabling when never enabled is a no-op and does not throw', () => {
    expect(() => setLinuxAutostart(false, deps())).not.toThrow()
    expect(existsSync(autostartFile())).toBe(false)
  })

  it('enabling twice overwrites with the same content rather than erroring', () => {
    setLinuxAutostart(true, deps())
    const first = readFileSync(autostartFile(), 'utf-8')

    setLinuxAutostart(true, deps())
    const second = readFileSync(autostartFile(), 'utf-8')

    expect(second).toBe(first)
  })

  it('disabling twice in a row does not throw', () => {
    setLinuxAutostart(true, deps())
    setLinuxAutostart(false, deps())
    expect(() => setLinuxAutostart(false, deps())).not.toThrow()
  })
})

describe('XDG_CONFIG_HOME', () => {
  it('is honoured over ~/.config when set', () => {
    const xdgHome = mkdtempSync(join(tmpdir(), 'flowdo-xdg-config-'))
    try {
      setLinuxAutostart(true, deps({ xdgConfigHome: xdgHome }))
      expect(existsSync(autostartFile(home, xdgHome))).toBe(true)
      // Falls back to ~/.config only when XDG_CONFIG_HOME is unset — not written there too.
      expect(existsSync(autostartFile())).toBe(false)
    } finally {
      rmSync(xdgHome, { recursive: true, force: true })
    }
  })
})

describe('exec target selection', () => {
  it('uses execPath when not running as an AppImage', () => {
    setLinuxAutostart(true, deps({ execPath: '/opt/Flowdo/flowdo' }))
    const contents = readFileSync(autostartFile(), 'utf-8')
    expect(contents).toContain('Exec=/opt/Flowdo/flowdo')
  })

  it('prefers the AppImage path over execPath when running as an AppImage', () => {
    setLinuxAutostart(
      true,
      deps({
        execPath: '/tmp/.mount_Flowdo123/flowdo',
        appImagePath: '/home/user/Applications/Flowdo-0.4.0.AppImage'
      })
    )
    const contents = readFileSync(autostartFile(), 'utf-8')
    expect(contents).toContain('Exec=/home/user/Applications/Flowdo-0.4.0.AppImage')
    expect(contents).not.toContain('/tmp/.mount_Flowdo123/flowdo')
  })
})

describe('Exec quoting', () => {
  it('leaves a plain path unquoted', () => {
    expect(quoteExecArg('/opt/Flowdo/flowdo')).toBe('/opt/Flowdo/flowdo')
  })

  it('quotes a path containing spaces', () => {
    expect(quoteExecArg('/home/user/My Apps/Flowdo.AppImage')).toBe(
      '"/home/user/My Apps/Flowdo.AppImage"'
    )
  })

  it('escapes double quotes, backticks, dollar signs and backslashes inside the quotes', () => {
    expect(quoteExecArg('/tmp/weird"name.AppImage')).toBe('"/tmp/weird\\"name.AppImage"')
    expect(quoteExecArg('/tmp/weird`name.AppImage')).toBe('"/tmp/weird\\`name.AppImage"')
    expect(quoteExecArg('/tmp/weird$name.AppImage')).toBe('"/tmp/weird\\$name.AppImage"')
    expect(quoteExecArg('/tmp/weird\\name.AppImage')).toBe('"/tmp/weird\\\\name.AppImage"')
  })

  it('a spaced AppImage path round-trips correctly into the written file', () => {
    setLinuxAutostart(
      true,
      deps({
        execPath: '/opt/flowdo',
        appImagePath: '/home/user/My Apps/Flowdo-0.4.0.AppImage'
      })
    )
    const contents = readFileSync(autostartFile(), 'utf-8')
    expect(contents).toContain('Exec="/home/user/My Apps/Flowdo-0.4.0.AppImage"')
  })
})

describe('desktopEntry', () => {
  it('is a pure function of the exec target', () => {
    const entry = desktopEntry('/usr/bin/flowdo')
    expect(entry).toContain('Exec=/usr/bin/flowdo')
    expect(entry.startsWith('[Desktop Entry]\n')).toBe(true)
  })
})

describe('isLinuxAutostartEnabled', () => {
  it('reflects the presence of the file', () => {
    expect(isLinuxAutostartEnabled(deps())).toBe(false)

    setLinuxAutostart(true, deps())
    expect(isLinuxAutostartEnabled(deps())).toBe(true)

    setLinuxAutostart(false, deps())
    expect(isLinuxAutostartEnabled(deps())).toBe(false)
  })

  it('respects XDG_CONFIG_HOME the same way setLinuxAutostart does', () => {
    const xdgHome = mkdtempSync(join(tmpdir(), 'flowdo-xdg-config-'))
    try {
      const d = deps({ xdgConfigHome: xdgHome })
      expect(isLinuxAutostartEnabled(d)).toBe(false)
      setLinuxAutostart(true, d)
      expect(isLinuxAutostartEnabled(d)).toBe(true)
    } finally {
      rmSync(xdgHome, { recursive: true, force: true })
    }
  })
})

describe('never throws on a broken home', () => {
  it('setLinuxAutostart swallows errors from a home directory that cannot be created under', () => {
    // A file (not a directory) standing in for what should be the autostart directory's
    // parent makes mkdirSync fail with ENOTDIR — exercising the catch-and-warn path.
    const blockedHome = mkdtempSync(join(tmpdir(), 'flowdo-blocked-home-'))
    const blockerPath = join(blockedHome, '.config')
    writeFileSync(blockerPath, 'not a directory')
    try {
      expect(() => setLinuxAutostart(true, deps({ homeDir: blockedHome }))).not.toThrow()
      expect(existsSync(join(blockerPath, 'autostart', 'flowdo.desktop'))).toBe(false)
    } finally {
      rmSync(blockedHome, { recursive: true, force: true })
    }
  })
})
