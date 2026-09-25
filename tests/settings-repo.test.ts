/**
 * `db/repo/settings.ts` validation for `weekStartsOn`, the one number-union setting: a
 * stored value that isn't exactly one of 0…6 must degrade to the default rather than reach
 * the calendar as a weekday that doesn't exist. Same electron-mock pattern as
 * `tests/stats-repo.test.ts` — a real `node:sqlite` file in a temp dir, real migrations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>() }))
vi.mock('electron', () => ({ app: { getPath: (name: string) => getPath(name) } }))

import { closeDb, getDb } from '../src/main/db'
import * as settingsRepo from '../src/main/db/repo/settings'
import { DEFAULT_SETTINGS } from '@shared/types'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-settings-test-'))
  getPath.mockReturnValue(dir)
})

afterEach(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

/** Store a raw JSON value the way a hand-edited or older database might hold it. */
function storeRaw(key: string, json: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, json)
}

describe('weekStartsOn', () => {
  it('defaults to Monday', () => {
    expect(DEFAULT_SETTINGS.weekStartsOn).toBe(1)
    expect(settingsRepo.get().weekStartsOn).toBe(1)
  })

  it('round-trips every weekday through set()', () => {
    for (const day of [0, 1, 2, 3, 4, 5, 6] as const) {
      expect(settingsRepo.set({ weekStartsOn: day }).weekStartsOn).toBe(day)
      expect(settingsRepo.get().weekStartsOn).toBe(day)
    }
  })

  it.each([
    ['out of range', '9'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['a numeric string', '"0"'],
    ['null', 'null'],
    ['unparseable JSON', '{not json']
  ])('falls back to the default for %s', (_label, json) => {
    storeRaw('weekStartsOn', json)
    expect(settingsRepo.get().weekStartsOn).toBe(DEFAULT_SETTINGS.weekStartsOn)
  })

  it('a bad weekStartsOn costs only that key', () => {
    settingsRepo.set({ theme: 'dark' })
    storeRaw('weekStartsOn', '42')
    const s = settingsRepo.get()
    expect(s.theme).toBe('dark')
    expect(s.weekStartsOn).toBe(1)
  })
})
