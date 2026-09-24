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

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The wall-clock date and time an instant reads as in a given IANA zone, e.g. for reusing
 * a provider's own `timezone` field rather than the host's — a Todoist due defined in
 * Asia/Tehran must show the time the user actually set it to, even when the host machine
 * sits in a different zone (Asia/Dubai, +30min off Tehran, is the case that surfaced this).
 *
 * `formatToParts` is used rather than slicing a formatted string, because `Intl` locale
 * output is not a fixed layout to depend on. `timeZone` is validated implicitly: an invalid
 * IANA name makes the `Intl.DateTimeFormat` constructor throw `RangeError`, which this
 * function catches and turns into `null` rather than letting propagate — never throws.
 */
export function wallClockInZone(
  ms: number,
  timeZone: string
): { dateKey: string; hhmm: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(ms))

    const get = (type: string): string | undefined => parts.find((p) => p.type === type)?.value
    const year = get('year')
    const month = get('month')
    const day = get('day')
    const hour = get('hour')
    const minute = get('minute')
    if (!year || !month || !day || !hour || !minute) return null

    return { dateKey: `${year}-${month}-${day}`, hhmm: `${hour}:${minute}` }
  } catch {
    return null
  }
}

/** The three due-time fields `Task` carries, always derived together — see `parseDueTime`. */
export interface DueTimeFields {
  dueTime: string | null
  dueZone: string | null
  dueTimeLocal: string | null
}

const NO_DUE_TIME: DueTimeFields = { dueTime: null, dueZone: null, dueTimeLocal: null }

/**
 * Parse a Todoist `due` object's JSON into the three due-time fields `Task` carries, in one
 * pass so they can never disagree with each other:
 *
 *  - `dueTime` — the wall-clock 'HH:MM' the due was authored at (in `due.timezone` when a
 *    zoned due names one, otherwise the host's own zone — see below).
 *  - `dueZone` — the IANA zone `dueTime` is expressed in, but ONLY for a zoned due with a
 *    recognised `due.timezone`; `null` for date-only, floating, or a zoned due whose
 *    `timezone` is missing/invalid (there `dueTime` still gets a value, via host-local
 *    fallback, but there is no named zone to report it in).
 *  - `dueTimeLocal` — the same instant read on THIS computer's own clock, so the UI can show
 *    both ("07:15 Tehran · 07:45 local") when they differ. Always `null` when `dueZone` is
 *    `null` — with no distinct authored zone there is nothing to disambiguate from `dueTime`.
 *
 * `due.date` comes in three shapes:
 *  - 'YYYY-MM-DD' — date-only, no time → all three `null`.
 *  - floating 'YYYY-MM-DDTHH:MM:SS' (no offset, no trailing `Z`) — there is no instant to
 *    convert, so `dueTime` is the HH:MM verbatim (exactly as `due_date`'s own local-day
 *    mapping treats a floating value), and `dueZone`/`dueTimeLocal` are `null` — a floating
 *    time has no zone to name.
 *  - zoned 'YYYY-MM-DDTHH:MM:SSZ' or with a `±HH:MM` offset — a real instant.
 *      - When `due.timezone` is present and a valid IANA name: `dueTime` is the wall time IN
 *        THAT ZONE via `wallClockInZone` (the time the user actually set, and what
 *        `due.string` describes — this can differ from the host's own zone even between
 *        "close" zones on a non-hour offset, e.g. Asia/Tehran vs Asia/Dubai). `dueZone` is
 *        that same timezone name. `dueTimeLocal` is the host-local HH:MM for the same
 *        instant, via `Date.getHours()/getMinutes()`.
 *      - Otherwise (timezone absent/invalid): `dueTime` falls back to the HOST's local zone,
 *        same as `dueTimeLocal` would have been — but `dueZone`/`dueTimeLocal` both stay
 *        `null`, since there is no authored zone distinct from the host to report.
 *
 * Never throws: malformed or unrecognised input degrades to all-`null`, same policy as
 * `isRecurring` above.
 */
export function parseDueTime(remoteDueJson: string | null): DueTimeFields {
  if (remoteDueJson === null) return NO_DUE_TIME
  try {
    const parsed: unknown = JSON.parse(remoteDueJson)
    if (typeof parsed !== 'object' || parsed === null) return NO_DUE_TIME
    const record = parsed as Record<string, unknown>
    const date = record.date
    if (typeof date !== 'string') return NO_DUE_TIME

    // Date-only: no time component at all.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/
    if (dateOnly.test(date)) return NO_DUE_TIME

    // Floating datetime: no trailing Z and no +/-HH:MM offset after the time.
    const floating = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):\d{2}$/
    const floatingMatch = floating.exec(date)
    if (floatingMatch) {
      const [, hh, mm] = floatingMatch
      return { dueTime: `${hh}:${mm}`, dueZone: null, dueTimeLocal: null }
    }

    // Zoned datetime: trailing Z or a +/-HH:MM offset. Convert via a real Date so the
    // calendar day (and clock time) is derived correctly, not sliced out of the UTC string.
    const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/
    if (zoned.test(date)) {
      const instant = new Date(date)
      if (Number.isNaN(instant.getTime())) return NO_DUE_TIME
      const hostLocal = `${pad2(instant.getHours())}:${pad2(instant.getMinutes())}`

      const timezone = record.timezone
      if (typeof timezone === 'string' && timezone.length > 0) {
        const wall = wallClockInZone(instant.getTime(), timezone)
        if (wall) {
          return { dueTime: wall.hhmm, dueZone: timezone, dueTimeLocal: hostLocal }
        }
        // Invalid/unrecognised IANA name: fall through to host-local below.
      }

      return { dueTime: hostLocal, dueZone: null, dueTimeLocal: null }
    }

    return NO_DUE_TIME
  } catch {
    return NO_DUE_TIME
  }
}

/** Back-compat single-field accessor, kept for call sites that only need `dueTime`. */
export function dueTimeFromRemoteDue(remoteDueJson: string | null): string | null {
  return parseDueTime(remoteDueJson).dueTime
}
