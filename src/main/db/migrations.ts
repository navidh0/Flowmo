/**
 * Forward-only schema migrations, keyed off `PRAGMA user_version`.
 *
 * No `_migrations` table: SQLite already carries a 32-bit integer in the file header for
 * exactly this, and it cannot drift out of sync with the schema it describes.
 *
 * Rules for adding one: append a new entry with the next version, never edit an existing
 * `up()`. A shipped migration has already run on someone's machine, so changing it makes
 * two installs with the same `user_version` mean different things.
 */

import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  version: number
  up(db: DatabaseSync): void
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE projects (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL,
          color      TEXT    NOT NULL,
          archived   INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE tasks (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title               TEXT    NOT NULL,
          notes               TEXT,
          priority            INTEGER NOT NULL DEFAULT 3,
          due_date            TEXT,
          estimated_pomodoros INTEGER,
          sort_order          INTEGER NOT NULL,
          completed_at        INTEGER,
          created_at          INTEGER NOT NULL
        );

        CREATE TABLE subtasks (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title      TEXT    NOT NULL,
          done       INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL
        );

        -- The two foreign keys are ON DELETE SET NULL, not CASCADE: deleting a task or a
        -- project must never erase the fact that the time was spent. An orphaned session
        -- still counts toward your totals and your streak.
        CREATE TABLE sessions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     INTEGER REFERENCES tasks(id)    ON DELETE SET NULL,
          project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
          mode        TEXT    NOT NULL,
          kind        TEXT    NOT NULL,
          started_at  INTEGER NOT NULL,
          ended_at    INTEGER NOT NULL,
          planned_ms  INTEGER,
          actual_ms   INTEGER NOT NULL,
          completed   INTEGER NOT NULL DEFAULT 1,
          interrupted INTEGER NOT NULL DEFAULT 0,
          notes       TEXT
        );

        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX idx_sessions_started        ON sessions(started_at);
        CREATE INDEX idx_sessions_project_started ON sessions(project_id, started_at);
        CREATE INDEX idx_sessions_task           ON sessions(task_id);
        CREATE INDEX idx_tasks_project_completed  ON tasks(project_id, completed_at);
      `)

      // A task has to belong to a project, so there has to be one before the user makes
      // anything. Seeded here rather than on every launch: if they rename or delete it,
      // it should stay renamed or deleted.
      db.prepare(
        'INSERT INTO projects (name, color, archived, sort_order, created_at) VALUES (?, ?, 0, 0, ?)'
      ).run('Inbox', '#6366f1', Date.now())
    }
  }
]

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get()
  const value = row?.['user_version']
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

/**
 * Apply every migration above the file's current version.
 *
 * The whole run is one transaction, so a half-applied schema is impossible: either the
 * database comes out at the target version or it is untouched and the app fails loudly
 * instead of writing into tables that only partly exist.
 */
export function runMigrations(db: DatabaseSync): void {
  const current = readUserVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  )
  if (pending.length === 0) return

  db.exec('BEGIN')
  try {
    for (const migration of pending) {
      // PRAGMA cannot take a bound parameter, so the version is interpolated — checked
      // here rather than trusted, since interpolation is interpolation.
      if (!Number.isInteger(migration.version)) {
        throw new Error(`db: migration version ${String(migration.version)} is not an integer`)
      }
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
