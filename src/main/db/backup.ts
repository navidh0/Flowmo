/**
 * A daily safety-net snapshot, taken right after the database is opened and migrated.
 *
 * Why this exists: the live database runs in WAL mode (see `index.ts`), which means the
 * data of record is split across `flowdo.db` and `flowdo.db-wal` — a WAL file that starts
 * fresh (as if from a brand-new empty database) looks, to anything reading just the main
 * file, like the database was emptied. A `VACUUM INTO` snapshot is a single self-contained
 * file with no WAL dependency, so it survives whatever produced that failure mode.
 *
 * This module never throws into startup: every failure is caught, logged (message only,
 * never data), and turned into a `null` return.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

const RETAIN_DAILY_BACKUPS = 14

/** 'YYYY-MM-DD' in LOCAL time — never `toISOString()`, which is UTC and would file a late
 *  evening backup under tomorrow's date near a day boundary. */
function localDateKey(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** SQL string-literal escaping: doubling embedded single quotes is the whole rule. */
function sqlQuote(path: string): string {
  return path.replace(/'/g, "''")
}

const BACKUP_NAME = /^flowdo-(\d{4}-\d{2}-\d{2})\.db$/

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as
    | { c: number | bigint }
    | undefined
  if (!row) return 0
  return typeof row.c === 'bigint' ? Number(row.c) : row.c
}

/**
 * A database counts as "empty" for backup purposes when there is nothing worth snapshotting
 * and, more importantly, nothing worth protecting the last good backup from: zero tasks,
 * zero sessions, and at most the single default project every fresh install seeds. Skipping
 * here — rather than writing an empty backup that would later be the "newest" and get kept
 * over a good one — is the actual point of this module.
 */
function looksEmpty(db: DatabaseSync): boolean {
  const tasks = countRows(db, 'tasks')
  const sessions = countRows(db, 'sessions')
  const projects = countRows(db, 'projects')
  return tasks === 0 && sessions === 0 && projects <= 1
}

/** Delete all but the newest `RETAIN_DAILY_BACKUPS` daily backup files, touching nothing
 *  else in the directory. */
function pruneOldBackups(backupDir: string): void {
  const entries = readdirSync(backupDir)
    .map((name) => BACKUP_NAME.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[0], dateKey: m[1] ?? '' }))
    // Lexical order on 'YYYY-MM-DD' is chronological order.
    .sort((a, b) => (a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0))

  for (const stale of entries.slice(RETAIN_DAILY_BACKUPS)) {
    try {
      unlinkSync(join(backupDir, stale.name))
    } catch (error) {
      console.warn('backupOnOpen: failed to prune old backup:', (error as Error).message)
    }
  }
}

/**
 * Write today's snapshot (if it doesn't already exist and the database isn't empty), then
 * prune backups beyond the retention window. Returns the path written, or `null` when no
 * backup was written (already exists today, database looks empty, or any failure).
 */
export function backupOnOpen(db: DatabaseSync, dir: string, now = new Date()): string | null {
  try {
    const backupDir = join(dir, 'backups')
    mkdirSync(backupDir, { recursive: true })

    const dateKey = localDateKey(now)
    const backupPath = join(backupDir, `flowdo-${dateKey}.db`)

    if (existsSync(backupPath)) return null
    if (looksEmpty(db)) return null

    db.exec(`VACUUM INTO '${sqlQuote(backupPath)}'`)

    pruneOldBackups(backupDir)

    return backupPath
  } catch (error) {
    console.warn('backupOnOpen: failed:', (error as Error).message)
    return null
  }
}
