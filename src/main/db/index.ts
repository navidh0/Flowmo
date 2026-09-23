/**
 * The database handle and the primitives every repo shares.
 *
 * This is the only file in db/ that imports Electron. The repos reach the connection
 * through `getDb()` and nothing else, so they can be exercised against a throwaway file
 * (or an in-memory database) without booting an Electron app.
 *
 * We use Node's builtin `node:sqlite` rather than better-sqlite3 deliberately: it ships
 * inside the Electron binary, so there is no native module to rebuild against Electron's
 * ABI and no C++ toolchain required on the build machine.
 */

import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import type { SyncSource } from '@shared/types'
import { runMigrations } from './migrations'

let handle: DatabaseSync | null = null

/**
 * Lazily open the database. Lazy because `app.getPath('userData')` is only meaningful
 * once Electron has resolved its paths, and because tests want to point `userData`
 * somewhere disposable before the first call.
 */
export function getDb(): DatabaseSync {
  if (handle) return handle

  const db = new DatabaseSync(join(app.getPath('userData'), 'flowdo.db'))

  // WAL keeps the writer from blocking readers, which matters because the timer writes a
  // session row at the same moment the stats screen is querying. busy_timeout turns the
  // remaining lock contention into a short wait instead of an SQLITE_BUSY throw.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  runMigrations(db)

  handle = db
  return handle
}

/** Close on shutdown so WAL is checkpointed and no -wal file is left behind. */
export function closeDb(): void {
  if (!handle) return
  handle.close()
  handle = null
}

/**
 * Run `body` inside a transaction, rolling back if it throws.
 *
 * Not nestable — SQLite has no nested BEGIN — which is fine because nothing in db/ calls
 * a transactional repo function from inside another one.
 */
export function tx<T>(body: (db: DatabaseSync) => T): T {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const result = body(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A raw row. Values are `null | number | bigint | string | Uint8Array`, so every column
 * read goes through one of the readers below — SQLite is dynamically typed and will hand
 * back a BigInt for a large integer, which would silently break arithmetic downstream.
 */
export type Row = Record<string, null | number | bigint | string | Uint8Array>

function fail(key: string, value: unknown): never {
  throw new Error(`db: column '${key}' held an unexpected ${typeof value} (${String(value)})`)
}

export function num(row: Row, key: string): number {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fail(key, value)
}

export function numOrNull(row: Row, key: string): number | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  return num(row, key)
}

export function str(row: Row, key: string): string {
  const value = row[key]
  if (typeof value === 'string') return value
  return fail(key, value)
}

export function strOrNull(row: Row, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  return str(row, key)
}

/** Booleans live as 0/1 INTEGER; the app never sees the integer form. */
export function bool(row: Row, key: string): boolean {
  return num(row, key) !== 0
}

/**
 * Read a single-column aggregate. An aggregate query always produces exactly one row,
 * but `.get()` is typed as possibly-undefined, and every caller would otherwise repeat
 * the same defensive branch.
 */
export function scalarNum(
  sql: string,
  params: ReadonlyArray<string | number | null>,
  fallback = 0
): number {
  const row = getDb()
    .prepare(sql)
    .get(...params)
  if (!row) return fallback
  const value = row['value']
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

/** SQLite has no boolean literal, so every write goes through this. */
export function toInt(value: boolean): number {
  return value ? 1 : 0
}

/** `lastInsertRowid` is `number | bigint`; ids cross IPC as plain numbers. */
export function rowId(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}

/** Every known sync source. An unrecognised stored value maps to `null`, never throws. */
const SYNC_SOURCES: readonly SyncSource[] = ['todoist']

/**
 * Read a `source` column as the `SyncSource` union or `null`.
 *
 * A stored value outside the union (e.g. left over from a removed integration, or a stray
 * hand-edit) degrades to `null` rather than reaching the app as an unknown string — the
 * same "wrong shape degrades to default" policy `settingsRepo.get()` applies.
 */
export function syncSourceOrNull(row: Row, key: string): SyncSource | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  const s = str(row, key)
  return (SYNC_SOURCES as readonly string[]).includes(s) ? (s as SyncSource) : null
}

/**
 * A task recurs upstream iff `remote_due` holds JSON whose `is_recurring` is `true`.
 *
 * Malformed or unexpected JSON must never throw here — this runs on every task read, and a
 * provider payload that does not parse the way we expect must degrade to "not recurring",
 * not crash the task list.
 */
export function isRecurring(remoteDue: string | null): boolean {
  if (remoteDue === null) return false
  try {
    const parsed: unknown = JSON.parse(remoteDue)
    if (typeof parsed !== 'object' || parsed === null) return false
    const record = parsed as Record<string, unknown>
    return record.is_recurring === true
  } catch {
    return false
  }
}
