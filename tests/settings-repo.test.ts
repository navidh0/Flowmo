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

describe('miniWidgetOnMinimize', () => {
  it('defaults to on', () => {
    expect(DEFAULT_SETTINGS.miniWidgetOnMinimize).toBe(true)
    expect(settingsRepo.get().miniWidgetOnMinimize).toBe(true)
  })

  it('round-trips and rejects a non-boolean', () => {
    expect(settingsRepo.set({ miniWidgetOnMinimize: false }).miniWidgetOnMinimize).toBe(false)
    storeRaw('miniWidgetOnMinimize', '"no"')
    expect(settingsRepo.get().miniWidgetOnMinimize).toBe(true)
  })
})

describe('mini widget position', () => {
  it('is null until the widget is first moved', () => {
    expect(settingsRepo.getMiniPosition()).toBeNull()
  })

  it('round-trips, and stays out of the Settings object', () => {
    settingsRepo.setMiniPosition({ x: -1200, y: 840 })
    expect(settingsRepo.getMiniPosition()).toEqual({ x: -1200, y: 840 })
    expect(Object.keys(settingsRepo.get())).not.toContain('internal:miniPosition')
  })

  it.each([
    ['not an object', '42'],
    ['a missing coordinate', '{"x":10}'],
    ['a non-finite coordinate', '{"x":10,"y":null}'],
    ['unparseable JSON', '{x:']
  ])('reads %s as no saved position', (_label, json) => {
    storeRaw('internal:miniPosition', json)
    expect(settingsRepo.getMiniPosition()).toBeNull()
  })
})

describe('mini widget size', () => {
  it('is null until the widget is first resized', () => {
    expect(settingsRepo.getMiniSize()).toBeNull()
  })

  it('round-trips, and stays out of the Settings object', () => {
    settingsRepo.setMiniSize({ width: 360, height: 150 })
    expect(settingsRepo.getMiniSize()).toEqual({ width: 360, height: 150 })
    expect(Object.keys(settingsRepo.get())).not.toContain('internal:miniSize')
  })

  it('is stored apart from the position, so one never overwrites the other', () => {
    settingsRepo.setMiniPosition({ x: 40, y: 60 })
    settingsRepo.setMiniSize({ width: 300, height: 120 })
    expect(settingsRepo.getMiniPosition()).toEqual({ x: 40, y: 60 })
    expect(settingsRepo.getMiniSize()).toEqual({ width: 300, height: 120 })
  })

  it.each([
    ['not an object', '42'],
    ['a missing dimension', '{"width":300}'],
    ['a non-numeric dimension', '{"width":"300","height":120}'],
    ['a non-finite dimension', '{"width":300,"height":null}'],
    ['unparseable JSON', '{width:']
  ])('reads %s as no saved size', (_label, json) => {
    storeRaw('internal:miniSize', json)
    expect(settingsRepo.getMiniSize()).toBeNull()
  })
})

describe('density', () => {
  it('defaults to comfortable', () => {
    expect(DEFAULT_SETTINGS.density).toBe('comfortable')
    expect(settingsRepo.get().density).toBe('comfortable')
  })

  it('round-trips compact', () => {
    expect(settingsRepo.set({ density: 'compact' }).density).toBe('compact')
    expect(settingsRepo.get().density).toBe('compact')
  })

  it.each([
    ['an unknown name', '"cozy"'],
    ['a non-string', '1'],
    ['null', 'null'],
    ['unparseable JSON', '{nope']
  ])('falls back to the default for %s', (_label, json) => {
    storeRaw('density', json)
    expect(settingsRepo.get().density).toBe('comfortable')
  })

  it('a bad density costs only that key', () => {
    settingsRepo.set({ theme: 'light' })
    storeRaw('density', '"tiny"')
    const s = settingsRepo.get()
    expect(s.theme).toBe('light')
    expect(s.density).toBe('comfortable')
  })
})
