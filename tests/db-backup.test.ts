/**
 * `backupOnOpen` is exercised directly against real `node:sqlite` databases in a temp
 * directory, without going through `getDb()` — the function takes `dir` as a plain
 * argument specifically so it doesn't need Electron mocked at all. `getDb()`'s one-line
 * call site is not re-tested here; that wiring is a single call the review of
 * `src/main/db/index.ts` covers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { backupOnOpen } from '../src/main/db/backup'
import { runMigrations } from '../src/main/db/migrations'

let dir: string
let dbPath: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowdo-backup-test-'))
  dbPath = join(dir, 'flowdo.db')
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedTask(): void {
  db.exec(`
    INSERT INTO tasks (project_id, title, priority, sort_order, created_at)
    VALUES (1, 'a real task', 3, 0, 0)
  `)
}

describe('backupOnOpen', () => {
  it('writes a valid snapshot that opens with the same row counts', () => {
    seedTask()

    const path = backupOnOpen(db, dir, new Date(2026, 8, 24))
    expect(path).toBe(join(dir, 'backups', 'flowdo-2026-09-24.db'))
    expect(existsSync(path!)).toBe(true)

    const opened = new DatabaseSync(path!)
    const row = opened.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }
    expect(row.c).toBe(1)
    const projRow = opened.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }
    expect(projRow.c).toBe(1)
    opened.close()
  })

  it('is a no-op the second time the same day', () => {
    seedTask()
    const now = new Date(2026, 8, 24)

    const first = backupOnOpen(db, dir, now)
    expect(first).not.toBeNull()

    // Mutate the live db so we can tell whether a second write happened.
    db.exec(`
      INSERT INTO tasks (project_id, title, priority, sort_order, created_at)
      VALUES (1, 'second task', 3, 1, 0)
    `)

    const second = backupOnOpen(db, dir, now)
    expect(second).toBeNull()

    const opened = new DatabaseSync(first!)
    const row = opened.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }
    expect(row.c).toBe(1) // still the first snapshot's contents, not overwritten
    opened.close()
  })

  it('skips an empty database and does not touch an existing good backup', () => {
    seedTask()
    const day1 = new Date(2026, 8, 23)
    const good = backupOnOpen(db, dir, day1)
    expect(good).not.toBeNull()

    // Simulate the emptied-database failure mode: a fresh db with nothing in it (still has
    // the single seeded default project from migrations, which alone must not count as
    // "non-empty") on the NEXT day, so the day-guard can't be the reason it's skipped.
    const day2 = new Date(2026, 8, 24)
    const emptyDb = new DatabaseSync(join(dir, 'empty.db'))
    runMigrations(emptyDb)
    const emptyResult = backupOnOpen(emptyDb, dir, day2)
    emptyDb.close()

    expect(emptyResult).toBeNull()
    // The day1 backup must still exist and be untouched.
    expect(existsSync(good!)).toBe(true)
    // day2's backup should not have been created by the empty db.
    expect(existsSync(join(dir, 'backups', 'flowdo-2026-09-24.db'))).toBe(false)
  })

  it('keeps 14 daily backups and deletes only matching filenames', () => {
    seedTask()
    const backupDir = join(dir, 'backups')
    mkdirSync(backupDir, { recursive: true })

    // Pre-create 15 fake daily backups (dates in the past) plus one foreign file.
    for (let i = 1; i <= 15; i++) {
      const d = String(i).padStart(2, '0')
      writeFileSync(join(backupDir, `flowdo-2026-08-${d}.db`), 'x')
    }
    writeFileSync(join(backupDir, 'not-a-backup.txt'), 'keep me')

    const result = backupOnOpen(db, dir, new Date(2026, 8, 24))
    expect(result).not.toBeNull()

    const names = readdirSync(backupDir)
    const dailies = names.filter((n) => /^flowdo-\d{4}-\d{2}-\d{2}\.db$/.test(n))
    expect(dailies.length).toBe(14)
    expect(names).toContain('not-a-backup.txt')

    // The oldest ones should be the ones pruned.
    expect(dailies).not.toContain('flowdo-2026-08-01.db')
    expect(dailies).not.toContain('flowdo-2026-08-02.db')
    expect(dailies).toContain('flowdo-2026-09-24.db')
  })

  it('works when the directory path contains a single quote', () => {
    const quoteDir = join(dir, "o'brien")
    mkdirSync(quoteDir, { recursive: true })
    seedTask()

    const path = backupOnOpen(db, quoteDir, new Date(2026, 8, 24))
    expect(path).not.toBeNull()
    expect(existsSync(path!)).toBe(true)

    const opened = new DatabaseSync(path!)
    const row = opened.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }
    expect(row.c).toBe(1)
    opened.close()
  })

  it('returns null without throwing when the target cannot be written', () => {
    // Make `dir/backups` impossible to create by occupying that path with a file.
    writeFileSync(join(dir, 'backups'), 'not a directory')

    expect(() => backupOnOpen(db, dir, new Date(2026, 8, 24))).not.toThrow()
    expect(backupOnOpen(db, dir, new Date(2026, 8, 24))).toBeNull()
  })
})
